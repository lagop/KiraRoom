/**
 * What an invoice PDF says, as strings ready to print: the content model
 * both renderers consume (the HTML template Chromium prints, and the plain
 * PDF writer used when Chromium is not there). Pure, so the legal content is
 * tested without rendering anything (invoice-document.spec.ts).
 *
 * The minimum of RD 1619/2012 (Reglamento de facturación), arts. 6, 7 y 15:
 *  - number and series, issue date;
 *  - issuer: name or razón social, NIF and address;
 *  - recipient: name, NIF and address when the invoice is a full one;
 *  - each line: description, quantity, unit price, tax rate;
 *  - per rate: taxable base, rate and cuota; the total;
 *  - a rectificativa says so, which invoice it rectifies (number and date)
 *    and why.
 *
 * Which document it is. A rectificativa is series R or a negative total, as
 * everywhere else in the code (accounting, invoice book, modelo 303). Of the
 * others, an invoice without the recipient's NIF can only be a factura
 * simplificada (art. 7: the recipient's identification is optional in it,
 * art. 4 allows it for hairdressing and beauty services up to 3.000 EUR),
 * so it is titled that way; with the NIF, "Factura".
 */

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRate: number;
  discountPct?: number;
  /** The loyalty reward's part of the discount, in the line's price terms (InvoiceLine.loyaltyDiscountCents). */
  loyaltyDiscountCents?: number;
  /** A promotion code's part of the discount, same terms, and the code (InvoiceLine.promotionDiscountCents). */
  promotionDiscountCents?: number;
  promotionCode?: string | null;
  /** The price was given with the tax included (InvoiceLine.taxIncluded): the loyalty amount is then with the tax. */
  taxIncluded?: boolean;
  totalCents: number;
}

export interface PdfAddress {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface InvoicePdfInput {
  tenant: {
    name: string;
    legalName?: string | null;
    taxId?: string | null;
    address?: PdfAddress | null;
    email?: string | null;
    phone?: string | null;
    logo?: string | null;
  };
  invoice: {
    series: string;
    number: string;
    /** An instant (ISO string or Date); printed as the salon's calendar day. */
    issueDate: string | Date;
    recipientName: string;
    recipientTaxId?: string | null;
    recipientAddress?: unknown;
    subtotalCents: number;
    totalCents: number;
    currency: string;
    status?: string | null;
    notes?: string | null;
    fiscalReference?: string | null;
    fiscalHash?: string | null;
    fiscalQrUrl?: string | null;
    /** Issuer as it was when the invoice was issued: wins over the salon's current data. */
    issuerNameAtIssue?: string | null;
    issuerTaxIdAtIssue?: string | null;
  };
  lines: InvoiceLine[];
  taxBreakdown: Array<{ rate: number; baseCents: number; taxCents: number }>;
  /** IVA, IGIC or IPSI, from the salon's regime. Default IVA. */
  taxLabel?: string;
  /** The salon's timezone, for the issue date. Default Europe/Madrid. */
  timezone?: string | null;
  /** On a rectificativa: the invoice it rectifies, when known. */
  rectifies?: { series: string; number: string; issueDate: string | Date } | null;
}

export type InvoiceKind = "invoice" | "simplified" | "rectifying";

export interface InvoiceDocument {
  kind: InvoiceKind;
  /** "Factura", "Factura simplificada" or "Factura rectificativa". */
  title: string;
  /** Series and number together, as the invoice is known ("A000001"). */
  fullNumber: string;
  series: string;
  number: string;
  /** dd/mm/yyyy on the salon's calendar. */
  issueDate: string;
  cancelled: boolean;
  issuer: { name: string; details: string[] };
  recipient: { name: string; details: string[] };
  taxLabel: string;
  lines: Array<{
    description: string;
    /**
     * "Dto. 10 %" when the line had a discount (its unit price is net of it);
     * the loyalty reward is named: "Descuento fidelidad 2,50 €", or
     * "Dto. 18 % (incluye Descuento fidelidad 2,50 €)" with a till discount too.
     */
    discount: string | null;
    quantity: string;
    unitPrice: string;
    taxRate: string;
    total: string;
  }>;
  /** One row per rate: "IVA 21 %", base, rate, cuota. */
  taxBreakdown: Array<{ label: string; rate: string; base: string; tax: string }>;
  totals: { base: string; taxes: Array<{ label: string; amount: string }>; total: string };
  /** Only on a rectificativa. */
  rectification: { original: string | null; originalDate: string | null; reason: string | null } | null;
  fiscal: { reference: string | null; hash: string | null };
}

export const DEFAULT_TIMEZONE = "Europe/Madrid";

/** "30,00 €", Spanish style. */
export function formatMoney(cents: number, currency = "EUR"): string {
  return (cents / 100).toLocaleString("es-ES", { style: "currency", currency: currency || "EUR" });
}

/** "21 %", "9,5 %". */
export function formatRate(rate: number): string {
  return `${Number(rate).toLocaleString("es-ES", { maximumFractionDigits: 2 })} %`;
}

function formatQuantity(quantity: number): string {
  return Number(quantity).toLocaleString("es-ES", { maximumFractionDigits: 3 });
}

/** dd/mm/yyyy of `instant` on the calendar of `timeZone`. */
export function formatDateInZone(instant: string | Date, timeZone?: string | null): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return String(instant);
  const format = (zone: string) =>
    new Intl.DateTimeFormat("es-ES", { timeZone: zone, day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  try {
    return format(timeZone || DEFAULT_TIMEZONE);
  } catch {
    // An unknown zone name: the salon's default rather than a crash.
    return format(DEFAULT_TIMEZONE);
  }
}

/** "Calle Mayor 1", "28001 Madrid (Madrid)", "España": the lines of an address. */
export function addressLines(address: unknown): string[] {
  if (!address) return [];
  if (typeof address === "string") return address.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (typeof address !== "object") return [];
  const a = address as Record<string, unknown>;
  const str = (...keys: string[]) => {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  const street = [str("street", "address", "line1"), str("line2")].filter(Boolean).join(", ");
  const city = str("city", "town", "locality");
  const state = str("state", "province", "region");
  const cityLine = [str("postalCode", "zip", "postcode"), city].filter(Boolean).join(" ");
  const withState = state && state !== city ? (cityLine ? `${cityLine} (${state})` : state) : cityLine;
  const country = countryName(str("country"));
  return [street, withState, country].filter(Boolean);
}

/** ES is the salon's default country: printed as España, others as given. */
function countryName(country: string): string {
  if (!country) return "";
  return country.toUpperCase() === "ES" ? "España" : country;
}

/** Rectificativa: series R or a negative total, as accounting and the 303 tell them. */
export function isRectifying(invoice: { series: string; totalCents: number }): boolean {
  return invoice.series === "R" || invoice.totalCents < 0;
}

/**
 * The prefix every rectificativa's note starts with
 * (invoices.service.ts rectificationNotePrefix), and what follows it: the
 * reason. Lines added later (a cancellation) are not part of it.
 */
const RECTIFICATION_NOTE = /^Rectificación de (\S+?):\s*(.*)$/;

export function parseRectificationNote(notes: string | null | undefined): { original: string; reason: string } | null {
  const first = String(notes ?? "").split(/\r?\n/)[0];
  const m = RECTIFICATION_NOTE.exec(first);
  if (!m) return null;
  return { original: m[1], reason: m[2].trim() };
}

export function buildInvoiceDocument(input: InvoicePdfInput): InvoiceDocument {
  const { invoice, tenant } = input;
  const currency = invoice.currency || "EUR";
  const taxLabel = input.taxLabel || "IVA";
  const zone = input.timezone || DEFAULT_TIMEZONE;
  const kind: InvoiceKind = isRectifying(invoice)
    ? "rectifying"
    : invoice.recipientTaxId
      ? "invoice"
      : "simplified";
  const title =
    kind === "rectifying" ? "Factura rectificativa" : kind === "simplified" ? "Factura simplificada" : "Factura";

  const issuerName = invoice.issuerNameAtIssue || tenant.legalName || tenant.name;
  const issuerTaxId = invoice.issuerTaxIdAtIssue || tenant.taxId || null;
  const issuerDetails = [
    issuerTaxId ? `NIF: ${issuerTaxId}` : "",
    ...addressLines(tenant.address),
    tenant.email ?? "",
    tenant.phone ?? "",
  ].filter(Boolean);
  // A commercial name different from the razón social is shown too, so the
  // client recognises the salon.
  if (tenant.name && issuerName !== tenant.name) issuerDetails.unshift(tenant.name);

  const recipientDetails = [
    invoice.recipientTaxId ? `NIF: ${invoice.recipientTaxId}` : "",
    ...addressLines(invoice.recipientAddress),
  ].filter(Boolean);

  const lines = input.lines.map((l) => {
    const discountPct = Number(l.discountPct ?? 0);
    const hasDiscount = Number.isFinite(discountPct) && discountPct > 0;
    return {
      description: l.description,
      discount: hasDiscount
        ? discountLabel(discountPct, Number(l.loyaltyDiscountCents ?? 0), l, currency, {
            cents: Number(l.promotionDiscountCents ?? 0),
            code: l.promotionCode ?? null,
          })
        : null,
      quantity: formatQuantity(l.quantity),
      // The price the line was charged at a unit: net of its discount.
      unitPrice: formatMoney(Math.round(l.unitPriceCents * (1 - (hasDiscount ? discountPct : 0) / 100)), currency),
      taxRate: formatRate(Number(l.taxRate)),
      total: formatMoney(l.totalCents, currency),
    };
  });

  const breakdown = [...(input.taxBreakdown ?? [])].sort((a, b) => Number(b.rate) - Number(a.rate));
  const taxBreakdown = breakdown.map((t) => ({
    label: `${taxLabel} ${formatRate(Number(t.rate))}`,
    rate: formatRate(Number(t.rate)),
    base: formatMoney(t.baseCents, currency),
    tax: formatMoney(t.taxCents, currency),
  }));

  let rectification: InvoiceDocument["rectification"] = null;
  if (kind === "rectifying") {
    const note = parseRectificationNote(invoice.notes);
    rectification = {
      original: input.rectifies ? `${input.rectifies.series}${input.rectifies.number}` : (note?.original ?? null),
      originalDate: input.rectifies ? formatDateInZone(input.rectifies.issueDate, zone) : null,
      reason: note ? note.reason || null : firstLine(invoice.notes),
    };
  }

  return {
    kind,
    title,
    fullNumber: `${invoice.series}${invoice.number}`,
    series: invoice.series,
    number: invoice.number,
    issueDate: formatDateInZone(invoice.issueDate, zone),
    cancelled: invoice.status === "cancelled",
    issuer: { name: issuerName, details: issuerDetails },
    recipient: { name: invoice.recipientName, details: recipientDetails },
    taxLabel,
    lines,
    taxBreakdown,
    totals: {
      base: formatMoney(invoice.subtotalCents, currency),
      taxes: taxBreakdown.map((t) => ({ label: t.label, amount: t.tax })),
      total: formatMoney(invoice.totalCents, currency),
    },
    rectification,
    fiscal: { reference: invoice.fiscalReference ?? null, hash: invoice.fiscalHash ?? null },
  };
}

/**
 * A line's discount as printed. The loyalty reward is a discount on the
 * invoice (owner decision 2026-11-02): it is named, with its amount; so is a
 * promotion code applied at the till ("Descuento promoción VERANO10 3,00 €").
 * When they are all of the line's discount, only their names and amounts.
 */
export function discountLabel(
  discountPct: number,
  loyaltyCents: number,
  line: { unitPriceCents: number; quantity: number; taxRate?: number; taxIncluded?: boolean },
  currency = "EUR",
  promotion?: { cents: number; code: string | null },
): string {
  const pct = `Dto. ${discountPct.toLocaleString("es-ES", { maximumFractionDigits: 2 })} %`;
  const promoCents = promotion && promotion.cents > 0 && promotion.code ? promotion.cents : 0;
  const named = [
    ...(promoCents > 0 ? [`Descuento promoción ${promotion!.code} ${formatMoney(promoCents, currency)}`] : []),
    ...(loyaltyCents > 0 ? [`Descuento fidelidad ${formatMoney(loyaltyCents, currency)}`] : []),
  ];
  if (named.length === 0) return pct;
  // The whole discount is the named ones (to the cent of the stored percent).
  // In their terms: with the tax when the price included it (the stored unit price is the base).
  const gross = line.taxIncluded ? 1 + Number(line.taxRate ?? 0) / 100 : 1;
  const discountCents = Math.round((line.unitPriceCents * gross * Number(line.quantity) * discountPct) / 100);
  const tolerance = Math.max(2, Math.ceil(Number(line.quantity)));
  const namedCents = Math.max(0, loyaltyCents) + promoCents;
  return Math.abs(discountCents - namedCents) <= tolerance ? named.join(" + ") : `${pct} (incluye ${named.join(" y ")})`;
}

function firstLine(text: string | null | undefined): string | null {
  const line = String(text ?? "").split(/\r?\n/)[0].trim();
  return line || null;
}
