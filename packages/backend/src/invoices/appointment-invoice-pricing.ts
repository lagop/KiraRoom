import { InvoiceCalculator, type InvoiceLineInput } from "./invoice-calculator.service";
import { VisitRow, visitLines } from "../appointments/visit-totals";
import { pricesIncludeTaxOf, salonTaxRate } from "./salon-tax-settings";
import { allocateCents } from "../pos/pos-discounts";
import { ServiceSnapshotColumns, bookedService } from "../appointments/appointment-snapshot";
import { prorateCapped } from "../pos/prorate";

export interface AppointmentToInvoice extends ServiceSnapshotColumns {
  /** Appointment.price: Decimal, in EUROS (not cents). */
  price: unknown;
  serviceId: string;
  service?: { name: string } | null;
}

/**
 * The invoice line for a completed appointment. Every pricing decision of the
 * automatic appointment invoice is made here:
 *
 *   - Amount: `Appointment.price`, in euros, converted to cents (Invoice
 *     amounts are integer cents). It is the whole visit: every service of a
 *     multi-service visit plus its add-ons (visit-totals.ts), kept equal to
 *     `Appointment.totalAmount`, which is already cents (never x100 again).
 *     One line per service: appointmentInvoiceLines, below.
 *   - Rate: the salon's `fiscalSettings.defaultTaxRate` (7 for an IGIC salon,
 *     for instance), else 21, the same rule POS order invoices follow.
 *   - Tax included or on top: the salon's `fiscalSettings.pricesIncludeTax`
 *     (salon-tax-settings.ts). Missing: on top, as before the setting.
 */
export function appointmentInvoiceLine(
  appointment: AppointmentToInvoice,
  fiscalSettings: Record<string, unknown>,
): InvoiceLineInput {
  return {
    // The service as it was booked (appointment-snapshot.ts), not as renamed since.
    description: bookedService(appointment)?.name || "Servicio",
    quantity: 1,
    unitPriceCents: Math.round(Number(appointment.price) * 100),
    taxRate: salonTaxRate(fiscalSettings),
    taxIncluded: pricesIncludeTaxOf(fiscalSettings),
    serviceId: appointment.serviceId,
  };
}

export interface VisitToInvoice extends AppointmentToInvoice {
  service?: { name: string; price?: unknown } | null;
  /** The visit's service rows, with their services (appointment_services). */
  services?: Array<VisitRow & { service?: { name?: string | null; price?: unknown; duration?: number | null } | null }>;
  /** Its add-ons, resolved to the catalog services they are (visit-sync.ts's addonServices). */
  addons?: Array<{ quantity: number; service: { id?: string; name?: string | null; price?: unknown } | null }>;
  /** Appointment.discount (JSON): a till discount sits under `pos` (pos.service.ts). */
  discount?: unknown;
}

/**
 * The cents a discount given at the till took off the visit
 * (`Appointment.discount.pos.amountCents`), else 0.
 */
export function tillDiscountCents(discount: unknown): number {
  const pos = (discount as { pos?: { amountCents?: unknown } } | null | undefined)?.pos;
  const cents = Number(pos?.amountCents);
  return Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0;
}

/**
 * The cents the client's loyalty reward took off the visit at the till, in
 * the visit's catalogue terms (`Appointment.discount.loyalty.catalogueCents`,
 * pos.service.ts), else 0. Unlike a till discount it does not lower the
 * visit's price (commissions stay on the price): it is paid with points, and
 * its invoice shows it as a discount ("Descuento fidelidad").
 */
export function loyaltyDiscountCents(discount: unknown): number {
  const loyalty = (discount as { loyalty?: { catalogueCents?: unknown } } | null | undefined)?.loyalty;
  const cents = Number(loyalty?.catalogueCents);
  return Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0;
}

/**
 * The MONEY the loyalty reward took off the visit at the till
 * (`Appointment.discount.loyalty.moneyCents`, pos.service.ts), else 0. For a
 * salon whose prices include the tax it is catalogueCents; otherwise the
 * invoice is brought to it (appointmentInvoiceLines).
 */
export function loyaltyMoneyCents(discount: unknown): number {
  const loyalty = (discount as { loyalty?: { moneyCents?: unknown } } | null | undefined)?.loyalty;
  const cents = Number(loyalty?.moneyCents);
  return Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0;
}

/** The visit without its loyalty record: what it costs before the reward (appointment-charge.ts). */
export function withoutLoyalty<V extends { discount?: unknown }>(visit: V): V {
  const d = visit.discount;
  if (!d || typeof d !== "object" || Array.isArray(d) || !("loyalty" in d)) return visit;
  const { loyalty: _loyalty, ...rest } = d as Record<string, unknown>;
  return { ...visit, discount: rest };
}

/**
 * The invoice lines for a completed visit: one per service and one per
 * add-on (with its quantity), from visit-totals.ts's visitLines, when they
 * add up to the visit's price -- the figure the client was charged
 * (`Appointment.price`, euros, the whole visit since multi-service totals
 * were fixed).
 *
 * When they do not (a catalog price changed after the booking, an imported
 * price), the invoice must still say what was charged: one line at the
 * visit's price, naming its services.
 *
 * A discount given at the till lowered the price to what was charged; the
 * invoice shows the price before it and the discount on each line
 * (`discountCents`, shared over the lines in proportion), so the lines
 * still come to what was charged and the tax is on the discounted amount.
 *
 * The loyalty reward used on the visit (loyaltyDiscountCents) is a discount
 * on the invoice too (owner decision 2026-11-02), so the invoice comes to
 * the money the client paid: shared over the lines in proportion to what
 * is left of each (prorate.ts: whole cents, the rounding on the largest
 * line), added to each line's discount and named on it (loyaltyDiscountCents).
 */
export function appointmentInvoiceLines(
  appointment: VisitToInvoice,
  fiscalSettings: Record<string, unknown>,
): InvoiceLineInput[] {
  return toMoneyCharged(appointment, fiscalSettings, linesBeforeRounding(appointment, fiscalSettings));
}

const calculator = new InvoiceCalculator();

/**
 * Prices that are the base: the reward was given in money (moneyCents) and
 * taken off the lines in base terms (catalogueCents, the closest cut), and
 * base x rate rounds per line, so the invoice can land a cent or two off
 * what was charged -- the invoice without the reward less its money. The
 * remainder goes on the tax of the last line that can take it
 * (InvoiceLineInput.roundingCents), the way a tax-included line's tax is
 * gross - base: the invoice then comes to the money charged, exactly.
 */
function toMoneyCharged(
  appointment: VisitToInvoice,
  fiscalSettings: Record<string, unknown>,
  lines: InvoiceLineInput[],
): InvoiceLineInput[] {
  const money = loyaltyMoneyCents(appointment.discount);
  if (pricesIncludeTaxOf(fiscalSettings) || money <= 0 || loyaltyDiscountCents(appointment.discount) <= 0) return lines;
  const before = calculator.compute(linesBeforeRounding(withoutLoyalty(appointment), fiscalSettings)).totalCents;
  const computed = calculator.compute(lines);
  const remainder = Math.max(0, before - money) - computed.totalCents;
  // Only rounding: each line rounds its tax once, and the reward's base cut once more.
  if (remainder === 0 || Math.abs(remainder) > lines.length + 1) return lines;
  for (let i = lines.length - 1; i >= 0; i--) {
    const { taxCents, totalCents } = computed.lines[i];
    if (taxCents + remainder >= 0 && totalCents + remainder >= 0 && taxCents > 0) {
      return lines.map((l, j) => (j === i ? { ...l, roundingCents: remainder } : l));
    }
  }
  return lines;
}

function linesBeforeRounding(appointment: VisitToInvoice, fiscalSettings: Record<string, unknown>): InvoiceLineInput[] {
  const tax = { taxRate: salonTaxRate(fiscalSettings), taxIncluded: pricesIncludeTaxOf(fiscalSettings) };
  const off = tillDiscountCents(appointment.discount);
  const loyalty = loyaltyDiscountCents(appointment.discount);
  const charged = Math.round(Number(appointment.price) * 100);
  const listed = charged + off;
  const lines = visitLines({
    mainService: { id: appointment.serviceId, ...(bookedService(appointment) ?? {}) },
    rows: appointment.services ?? [],
    addons: appointment.addons ?? [],
  });
  const sum = lines.reduce((total, l) => total + l.unitPriceCents * l.quantity, 0);
  if (lines.length > 1 && sum === listed) {
    const shares = allocateCents(off, lines.map((l) => l.unitPriceCents * l.quantity));
    const left = lines.map((l, i) => l.unitPriceCents * l.quantity - shares[i]);
    const rewards = prorateCapped(loyalty, left.map((cents) => ({ weight: cents, cap: cents })));
    return lines.map((l, i) => ({
      ...l,
      ...tax,
      ...(shares[i] + rewards[i] > 0 ? { discountCents: shares[i] + rewards[i] } : {}),
      ...(rewards[i] > 0 ? { loyaltyDiscountCents: rewards[i] } : {}),
    }));
  }
  const names = [...new Set(lines.map((l) => l.description))];
  return [
    {
      ...appointmentInvoiceLine(appointment, fiscalSettings),
      ...(names.length > 1 ? { description: names.join(" + ") } : {}),
      ...(off > 0 ? { unitPriceCents: listed } : {}),
      ...(off + Math.min(loyalty, charged) > 0 ? { discountCents: off + Math.min(loyalty, charged) } : {}),
      ...(Math.min(loyalty, charged) > 0 ? { loyaltyDiscountCents: Math.min(loyalty, charged) } : {}),
    },
  ];
}
