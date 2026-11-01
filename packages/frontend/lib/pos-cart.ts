/**
 * The till's ticket and tenders, as the panel builds them. Pure, tested in
 * lib/pos-cart.spec.ts.
 *
 * Every amount is in cents of MONEY: tax included, what the client pays and
 * what the invoice says, whatever the salon's "prices include VAT" setting
 * (the server prices every line; GET /pos/services and /pos/sale-products
 * send `chargeCents`, an appointment its `amountDue`). The panel shows the
 * server's quote (POST /pos/quote) and charges exactly its total.
 *
 * Lines are keyed by what they sell: an appointment by its id, a service by
 * its id and who did it, a product by its id. Two lines of the same service
 * (an appointment and one more sold at the till) are two lines: changing
 * one never touches the other.
 */
import type { DiscountSpec } from "./pos-discounts";

export type CartLineKind = "appointment" | "service" | "product";

export interface CartLine {
  key: string;
  kind: CartLineKind;
  /** The service (appointment and service lines) or product sold. */
  serviceId?: string;
  productId?: string;
  appointmentId?: string;
  /** Who did a service sold without an appointment (commissions). */
  professionalId?: string;
  name: string;
  /** Money cents per unit, tax included. */
  unitCents: number;
  quantity: number;
  discount?: DiscountSpec;
  /** A product's units in stock, when counted. */
  stock?: number | null;
}

export interface GiftCardSale {
  key: string;
  amountCents: number;
  recipientName?: string;
  recipientEmail?: string;
  message?: string;
}

export function lineKey(line: Pick<CartLine, "kind" | "serviceId" | "productId" | "appointmentId" | "professionalId">): string {
  if (line.kind === "appointment") return `apt:${line.appointmentId}`;
  if (line.kind === "product") return `prod:${line.productId}`;
  return `svc:${line.serviceId}:${line.professionalId ?? ""}`;
}

/** Adds a line, or one more unit of the same one. An appointment is charged once. */
export function addLine(cart: CartLine[], line: Omit<CartLine, "key" | "quantity"> & { quantity?: number }): CartLine[] {
  const key = lineKey(line);
  const existing = cart.find((l) => l.key === key);
  if (existing) {
    if (existing.kind === "appointment") return cart;
    return cart.map((l) => (l.key === key ? { ...l, quantity: l.quantity + (line.quantity ?? 1) } : l));
  }
  return [...cart, { ...line, key, quantity: line.kind === "appointment" ? 1 : line.quantity ?? 1 }];
}

/** Sets a line's quantity; 0 or less removes it. An appointment stays at 1. */
export function setQuantity(cart: CartLine[], key: string, quantity: number): CartLine[] {
  if (quantity <= 0) return removeLine(cart, key);
  return cart.map((l) => (l.key === key && l.kind !== "appointment" ? { ...l, quantity: Math.floor(quantity) } : l));
}

export function removeLine(cart: CartLine[], key: string): CartLine[] {
  return cart.filter((l) => l.key !== key);
}

/** Changes who did a service line: it becomes the line of that professional (merged if there is one). */
export function setProfessional(cart: CartLine[], key: string, professionalId: string | undefined): CartLine[] {
  const line = cart.find((l) => l.key === key);
  if (!line || line.kind !== "service") return cart;
  const moved = { ...line, professionalId: professionalId || undefined };
  const newKey = lineKey(moved);
  if (newKey === key) return cart;
  const rest = cart.filter((l) => l.key !== key);
  const target = rest.find((l) => l.key === newKey);
  if (target) return rest.map((l) => (l.key === newKey ? { ...l, quantity: l.quantity + line.quantity } : l));
  return cart.map((l) => (l.key === key ? { ...moved, key: newKey } : l));
}

/** The lines as POST /pos/checkout and /pos/quote take them: what is sold, never a price. */
export function itemsForServer(cart: CartLine[]) {
  return cart.map((l) => ({
    ...(l.serviceId ? { serviceId: l.serviceId } : {}),
    ...(l.productId ? { productId: l.productId } : {}),
    ...(l.appointmentId ? { appointmentId: l.appointmentId } : {}),
    ...(l.kind === "service" && l.professionalId ? { professionalId: l.professionalId } : {}),
    quantity: l.quantity,
    ...(l.discount ? { discount: l.discount } : {}),
  }));
}

export function giftCardsForServer(cards: GiftCardSale[]) {
  return cards.map((c) => ({
    amountCents: c.amountCents,
    ...(c.recipientName?.trim() ? { recipientName: c.recipientName.trim() } : {}),
    ...(c.recipientEmail?.trim() ? { recipientEmail: c.recipientEmail.trim() } : {}),
    ...(c.message?.trim() ? { message: c.message.trim() } : {}),
  }));
}

// ------------------------------------------------------------------ tenders

export type TenderMethod = "cash" | "card" | "bizum" | "bank_transfer" | "gift_card" | "wallet";

export const TENDER_LABELS: Record<TenderMethod, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  bizum: "Bizum",
  bank_transfer: "Transferencia",
  gift_card: "Tarjeta regalo",
  wallet: "Cartera",
};

export interface Tender {
  method: TenderMethod;
  /** Cents handed over with this method (cash: what was given, change included). */
  amount: number;
  giftCardCode?: string;
}

export const sumTenders = (tenders: Tender[]) => tenders.reduce((s, t) => s + (t.amount || 0), 0);

/** Cash handed over beyond what is due: given back. */
export function changeCents(tenders: Tender[], dueCents: number): number {
  return Math.max(0, sumTenders(tenders) - dueCents);
}

/** What is still to be charged. */
export function remainingCents(tenders: Tender[], dueCents: number): number {
  return Math.max(0, dueCents - sumTenders(tenders));
}

/** Tender `index` takes what the others leave of the total (mixed payments). */
export function fillRemainder(tenders: Tender[], dueCents: number, index = tenders.length - 1): Tender[] {
  const others = tenders.reduce((s, t, i) => (i === index ? s : s + (t.amount || 0)), 0);
  return tenders.map((t, i) => (i === index ? { ...t, amount: Math.max(0, dueCents - others) } : t));
}

/** A second (third...) way to pay, taking what is left; the first method not used yet. */
export function addTender(tenders: Tender[], dueCents: number, method?: TenderMethod): Tender[] {
  const used = new Set(tenders.map((t) => t.method));
  const next = method ?? (["card", "cash", "bizum", "bank_transfer"] as TenderMethod[]).find((m) => !used.has(m)) ?? "card";
  return fillRemainder([...tenders, { method: next, amount: 0 }], dueCents);
}

/**
 * Why the server would refuse these tenders, in its words (pos-tenders.ts):
 * short of the total; more than the total from anything but cash; a gift
 * card without its code. Null when they are fine.
 */
export function tenderProblem(tenders: Tender[], dueCents: number): string | null {
  if (tenders.length === 0) return "Elige cómo paga la clienta.";
  if (tenders.some((t) => !Number.isInteger(t.amount) || t.amount < 0)) return "Revisa los importes.";
  if (tenders.some((t) => t.method === "gift_card" && !t.giftCardCode?.trim())) {
    return "Escribe el código de la tarjeta regalo.";
  }
  const paid = sumTenders(tenders);
  if (paid < dueCents) return `Faltan ${euros(dueCents - paid)} por cobrar.`;
  const cash = tenders.filter((t) => t.method === "cash").reduce((s, t) => s + t.amount, 0);
  if (paid - dueCents > cash) {
    return "Con tarjeta, Bizum, transferencia o tarjeta regalo se cobra exactamente lo que falta: solo el efectivo puede ser mayor.";
  }
  return null;
}

/** The tenders as POST /pos/checkout takes them (empty ones left out, codes trimmed). */
export function tendersForServer(tenders: Tender[]): Tender[] {
  const kept = tenders
    .filter((t) => t.amount > 0)
    .map((t) => ({
      method: t.method,
      amount: t.amount,
      ...(t.method === "gift_card" ? { giftCardCode: (t.giftCardCode ?? "").trim().toUpperCase() } : {}),
    }));
  // A ticket that costs nothing still records its (zero) tender.
  return kept.length > 0 ? kept : tenders.slice(0, 1).map((t) => ({ method: t.method, amount: 0 }));
}

// ------------------------------------------------------------------ money

/** "12,50", "12.5", "12" → cents; null for anything else. */
export function parseEurosInput(text: string): number | null {
  const clean = text.trim().replace(/\s|€/g, "").replace(",", ".");
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}

/** Cents as euros, Spanish style: "12,50 €". */
export function euros(cents: number): string {
  return (cents / 100).toLocaleString("es-ES", { style: "currency", currency: "EUR" });
}

/** A fresh id for a sale: the server records it once, however many times it is sent. */
export function newSaleId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback (old browsers): a v4 UUID from Math.random.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ------------------------------------------------------------------ the tender form

/** A row of the "how she pays" form: the amount as typed (euros). */
export interface TenderRow {
  method: TenderMethod;
  /** Euros as typed; empty on a single row means "exactly what is due". */
  amountText: string;
  giftCardCode?: string;
  /** A gift card's balance once looked up, cents. */
  balanceCents?: number | null;
}

/**
 * The tenders the form says. One row with no amount typed pays exactly what
 * is due (with cash, what is typed is what was handed over: "Entregado").
 */
export function tendersOfRows(rows: TenderRow[], dueCents: number): Tender[] {
  return rows.map((r) => {
    const typed = r.amountText.trim() === "" ? null : parseEurosInput(r.amountText);
    const amount = rows.length === 1 && typed === null && r.amountText.trim() === "" ? dueCents : typed ?? -1;
    return { method: r.method, amount, ...(r.method === "gift_card" ? { giftCardCode: r.giftCardCode ?? "" } : {}) };
  });
}

/** Euros for an amount input: 1250 → "12,50". */
export function eurosInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/**
 * The form after row `index` was typed in: on a mixed payment the LAST row
 * takes what the others leave (unless it was the one typed).
 */
export function refillRows(rows: TenderRow[], dueCents: number, index: number): TenderRow[] {
  if (rows.length < 2) return rows;
  const last = rows.length - 1;
  if (index === last) return rows;
  const others = rows.reduce((s, r, i) => (i === last ? s : s + (parseEurosInput(r.amountText) ?? 0)), 0);
  return rows.map((r, i) => (i === last ? { ...r, amountText: eurosInput(Math.max(0, dueCents - others)) } : r));
}

/** A second way to pay, pre-filled with what is left. */
export function addTenderRow(rows: TenderRow[], dueCents: number): TenderRow[] {
  // A single row with nothing typed was paying all of it: make that explicit first.
  const base = rows.length === 1 && rows[0].amountText.trim() === "" ? [{ ...rows[0], amountText: eurosInput(dueCents) }] : rows;
  const tenders = tendersOfRows(base, dueCents);
  const used = new Set(base.map((r) => r.method));
  const method = (["card", "cash", "bizum", "bank_transfer"] as TenderMethod[]).find((m) => !used.has(m)) ?? "card";
  const left = Math.max(0, dueCents - sumTenders(tenders.map((t) => ({ ...t, amount: Math.max(0, t.amount) }))));
  return [...base, { method, amountText: eurosInput(left) }];
}
