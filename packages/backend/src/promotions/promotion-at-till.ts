import { BadRequestException, ConflictException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { salonInstant } from "../appointments/salon-time";
import { addDays } from "../analytics/analytics-metrics";
import { discountCents } from "../pos/pos-discounts";
import { loyaltyShares } from "../pos/pos-ticket";

/**
 * A promotion code applied at the till (POS). The till is the only place a
 * code is used: POST /pos/quote prices it, POST /pos/checkout writes its use
 * in the sale's transaction (claimPromotionIn), and a full refund of the
 * sale gives the use back (releaseSalePromotionIn). GET
 * /promotions/validate/:code only says whether a code is good today.
 *
 * The rules, in one place:
 *
 *   - Valid from the start of its start day to the end of its end day, in
 *     the salon's clock (safeTimeZone, as the till's day). The days are
 *     calendar days stored as their UTC midnight (the panel's date inputs).
 *   - Active, not archived, and not a "compra X y llévate Y" (the till has
 *     no way to say X or Y).
 *   - `maxUses`: the total uses, claimed in the sale's transaction with a
 *     conditional update (usedCount < maxUses): two tills using the last
 *     use at once, one gets it, the other a 409.
 *   - `maxUsesPerClient`: needs a client on the sale; counted after that
 *     update, which holds the promotion's row lock, so two sales of the same
 *     client cannot both pass.
 *   - `minOrderValue`: what the ticket costs after the manual discounts
 *     (gift cards sold on it do not count) must reach it.
 *   - `applicableServiceIds` / `applicableProductIds`: when either is set,
 *     the discount comes off only those lines (an appointment by its main
 *     service); else off every line.
 *   - Order with the other discounts: the manual ones (line, then ticket)
 *     first, then the promotion on what is left, then the loyalty reward on
 *     what is left after it, then a gift card pays as a tender. The
 *     promotion is outside the staff's manual-discount limit.
 *   - The amount is shared over the lines it applies to in proportion to
 *     their tax base (pos-ticket.ts loyaltyShares, as the loyalty reward), so
 *     each line's base and tax go down by its share and the invoice says
 *     "Descuento promoción CODE" on it.
 */

/** The promotion's columns the till reads. */
export const TILL_PROMOTION_SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  value: true,
  minOrderValue: true,
  maxUses: true,
  maxUsesPerClient: true,
  usedCount: true,
  startDate: true,
  endDate: true,
  isActive: true,
  archivedAt: true,
  applicableServiceIds: true,
  applicableProductIds: true,
} as const;

export interface TillPromotion {
  id: string;
  code: string;
  name: string;
  type: string;
  /** Percent, or euros for FIXED (a Prisma Decimal). */
  value: unknown;
  /** Euros (a Prisma Decimal), or null. */
  minOrderValue: unknown;
  maxUses: number | null;
  maxUsesPerClient: number | null;
  usedCount: number;
  startDate: Date;
  endDate: Date | null;
  isActive: boolean;
  archivedAt?: Date | null;
  applicableServiceIds: unknown;
  applicableProductIds: unknown;
}

/** As typed at the till, as stored: no spaces around it, upper case. */
export function normalizePromotionCode(code: string): string {
  return String(code ?? "").trim().toUpperCase();
}

function euros(cents: number): string {
  return (cents / 100).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

/** The calendar day a stored date stands for (its UTC date). */
function dayOf(date: Date): string {
  return new Date(date).toISOString().slice(0, 10);
}

/** When the promotion is valid in the salon's clock: [from, until), until null when it has no end. */
export function promotionWindow(
  p: Pick<TillPromotion, "startDate" | "endDate">,
  timeZone: string,
): { from: Date; until: Date | null } {
  return {
    from: salonInstant(dayOf(p.startDate), "00:00", timeZone),
    until: p.endDate ? salonInstant(addDays(dayOf(p.endDate), 1), "00:00", timeZone) : null,
  };
}

/** Why the code cannot be used now, in Spanish (null: it can). The per-client limit is checked with the client. */
export function promotionProblem(p: TillPromotion, now: Date, timeZone: string): string | null {
  if (p.archivedAt || !p.isActive) return "La promoción ya no está activa.";
  if (p.type !== "PERCENTAGE" && p.type !== "FIXED") {
    return "Esta promoción no se puede aplicar en caja: solo las de porcentaje o importe fijo.";
  }
  const { from, until } = promotionWindow(p, timeZone);
  if (now < from) return "La promoción todavía no ha empezado.";
  if (until && now >= until) return "La promoción ha terminado.";
  if (p.maxUses != null && p.usedCount >= p.maxUses) return "La promoción ya ha llegado a su máximo de usos.";
  return null;
}

/** The ids of a JSON list column (anything else: none). */
export function idList(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

/** Whether the promotion is limited to some services or products. */
export function isRestricted(p: Pick<TillPromotion, "applicableServiceIds" | "applicableProductIds">): boolean {
  return idList(p.applicableServiceIds).length > 0 || idList(p.applicableProductIds).length > 0;
}

/** Whether the promotion comes off this line. */
export function promotionAppliesTo(
  p: Pick<TillPromotion, "applicableServiceIds" | "applicableProductIds">,
  line: { kind: string; serviceId?: string; productId?: string },
): boolean {
  if (!isRestricted(p)) return true;
  if (line.kind === "product") return !!line.productId && idList(p.applicableProductIds).includes(line.productId);
  return !!line.serviceId && idList(p.applicableServiceIds).includes(line.serviceId);
}

/** What the promotion takes off `baseCents` (whole cents; a percent rounds half up, as the till's discounts). */
export function promotionCentsOff(p: Pick<TillPromotion, "type" | "value">, baseCents: number): number {
  if (baseCents <= 0) return 0;
  const value = Number(p.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (p.type === "PERCENTAGE") return discountCents({ type: "percentage", value: Math.min(100, value) }, baseCents);
  if (p.type === "FIXED") return Math.min(Math.round(value * 100), baseCents);
  return 0;
}

export interface PromotionOnLines {
  /** What the promotion takes off the ticket (money cents). */
  cents: number;
  /** What it came off: the lines it applies to, after their manual discounts. */
  baseCents: number;
  /** Each line's share, in the order of `lines` (0 for the lines it does not apply to). */
  shares: number[];
}

/**
 * The promotion on the ticket's lines (money cents, after the manual
 * discounts): refused (400) under the minimum order or when nothing on the
 * ticket is one of its services; else its amount, shared over the lines it
 * applies to by their tax base.
 */
export function promotionOnLines(
  p: TillPromotion,
  lines: Array<{ kind: string; serviceId?: string; productId?: string; netCents: number; taxRate: number }>,
  orderCents: number,
): PromotionOnLines {
  const minCents = Math.round(Number(p.minOrderValue ?? 0) * 100);
  if (minCents > 0 && orderCents < minCents) {
    throw new BadRequestException(
      `El importe mínimo para usar la promoción es ${euros(minCents)} y el ticket suma ${euros(Math.max(0, orderCents))}.`,
    );
  }
  const eligible = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.netCents > 0 && promotionAppliesTo(p, l));
  if (eligible.length === 0) {
    throw new BadRequestException(
      isRestricted(p)
        ? "La promoción solo vale para algunos servicios y no hay ninguno de ellos en este ticket."
        : "No hay nada en el ticket a lo que aplicar la promoción.",
    );
  }
  const baseCents = eligible.reduce((s, { l }) => s + l.netCents, 0);
  const cents = promotionCentsOff(p, baseCents);
  const parts = loyaltyShares(
    eligible.map(({ l }) => ({ netCents: l.netCents, taxRate: l.taxRate })),
    cents,
  );
  const shares = lines.map(() => 0);
  eligible.forEach(({ i }, k) => {
    shares[i] = parts[k];
  });
  return { cents, baseCents, shares };
}

type Tx = Prisma.TransactionClient | any;

/** 400 unless the client may still use it (per-client limit). Read outside a transaction it is only a warning. */
export async function assertClientMayUse(db: Tx, p: TillPromotion, clientId: string | null | undefined): Promise<void> {
  if (!p.maxUsesPerClient) return;
  if (!clientId) {
    throw new BadRequestException("Esta promoción tiene un límite de usos por clienta: elige a la clienta para aplicarla.");
  }
  const used = await db.promotionUsage.count({ where: { promotionId: p.id, clientId, releasedAt: null } });
  if (used >= p.maxUsesPerClient) {
    throw new BadRequestException("Esta clienta ya ha usado la promoción las veces permitidas.");
  }
}

/**
 * Inside the sale's transaction: takes one use of the promotion and writes
 * it (PromotionUsage). The conditional update is the global limit and holds
 * the promotion's row until the sale commits, so the per-client count after
 * it sees every use committed before. Throws (and the sale rolls back) when
 * either limit is reached or the promotion was switched off meanwhile.
 */
export async function claimPromotionIn(
  tx: Tx,
  args: {
    tenantId: string;
    promotion: TillPromotion;
    clientId: string | null;
    saleId: string;
    appointmentId: string | null;
    discountCents: number;
  },
): Promise<{ usageId: string }> {
  const p = args.promotion;
  const limit = p.maxUses == null ? { maxUses: null } : { maxUses: p.maxUses, usedCount: { lt: p.maxUses } };
  const { count } = await tx.promotion.updateMany({
    where: { id: p.id, tenantId: args.tenantId, isActive: true, archivedAt: null, ...limit },
    data: { usedCount: { increment: 1 } },
  });
  if (count !== 1) {
    const now = await tx.promotion.findFirst({
      where: { id: p.id, tenantId: args.tenantId },
      select: { usedCount: true, maxUses: true, isActive: true, archivedAt: true },
    });
    const full = now && now.maxUses != null && now.usedCount >= now.maxUses;
    throw new ConflictException({
      code: "PROMOTION_NOT_AVAILABLE",
      message: full
        ? "La promoción acaba de llegar a su máximo de usos: cobra sin ella."
        : now && (!now.isActive || now.archivedAt)
          ? "La promoción ya no está activa: cobra sin ella."
          : "La promoción acaba de cambiar. Vuelve a aplicar el código.",
    });
  }
  await assertClientMayUse(tx, p, args.clientId);
  const usage = await tx.promotionUsage.create({
    data: {
      promotionId: p.id,
      clientId: args.clientId,
      saleId: args.saleId,
      appointmentId: args.appointmentId,
      discountAmount: args.discountCents / 100,
    },
    select: { id: true },
  });
  return { usageId: usage.id };
}

/**
 * Inside a refund's transaction: the sale's promotion uses are released
 * (releasedAt) and given back to the promotion (usedCount - 1), each once.
 * Returns how many were released.
 */
export async function releaseSalePromotionIn(tx: Tx, tenantId: string, saleId: string): Promise<number> {
  const usages = await tx.promotionUsage.findMany({
    where: { saleId, releasedAt: null, promotion: { tenantId } },
    select: { id: true, promotionId: true },
  });
  let released = 0;
  for (const u of usages) {
    const { count } = await tx.promotionUsage.updateMany({
      where: { id: u.id, releasedAt: null },
      data: { releasedAt: new Date() },
    });
    if (count !== 1) continue;
    await tx.promotion.updateMany({
      where: { id: u.promotionId, tenantId, usedCount: { gt: 0 } },
      data: { usedCount: { decrement: 1 } },
    });
    released += 1;
  }
  return released;
}

/**
 * After a payment of a till sale was refunded in full (inside the refund's
 * transaction, its status already refunded): when no payment of the sale is
 * left paid, the whole sale was given back and its promotion use is
 * released. A partial refund keeps it.
 */
export async function releaseIfSaleRefundedIn(tx: Tx, tenantId: string, saleId: string): Promise<number> {
  const stillPaid = await tx.payment.count({
    where: { tenantId, status: "paid", metadata: { path: ["posSaleId"], equals: saleId } },
  });
  if (stillPaid > 0) return 0;
  return releaseSalePromotionIn(tx, tenantId, saleId);
}
