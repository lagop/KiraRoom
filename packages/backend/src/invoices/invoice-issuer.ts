import { Logger, UnprocessableEntityException } from "@nestjs/common";
import { salonDay } from "./invoice-numbering";

/**
 * The salon's data as the issuer of an invoice: NIF, razón social and fiscal
 * address. They are mandatory on every invoice, simplified ones included
 * (arts. 6-7 RD 1619/2012), and an invoice without them is not valid.
 *
 * For now the panel warns the owner and admins (GET /invoices/issuer-status).
 * From the day in INVOICE_ISSUER_BLOCK_FROM ("YYYY-MM-DD", the salon's
 * calendar day) issuing an invoice without them is refused with a 422 that
 * says what is missing. Unset: warn only. A value that is not a date: warn
 * only too, and logged, so a typo never starts refusing invoices.
 *
 * Who refuses and who skips: a manual invoice and an appointment invoiced on
 * request answer the 422. A sale at the till never fails for it: the sale is
 * recorded without its invoice and the answer says so (PosService). The
 * automatic invoice of a completed appointment is skipped and logged.
 * Rectificativas are never blocked: they correct invoices already issued
 * (and the till issues them inside the sale).
 */

export type IssuerField = "taxId" | "legalName" | "address";

export interface IssuerRow {
  taxId?: string | null;
  legalName?: string | null;
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  fiscalSettings?: unknown;
}

/** What the Tenant select needs for issuerMissing(). */
export const ISSUER_SELECT = {
  taxId: true,
  legalName: true,
  street: true,
  postalCode: true,
  city: true,
  fiscalSettings: true,
} as const;

const filled = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

/**
 * The issuer data the salon has not filled in, in the order the message
 * names them. The NIF may still only be in fiscalSettings.tenantNif (salons
 * from before the Tenant column), which is what invoices copy then.
 */
export function issuerMissing(tenant: IssuerRow | null | undefined): IssuerField[] {
  const settings = (tenant?.fiscalSettings as Record<string, unknown> | null) ?? {};
  const missing: IssuerField[] = [];
  if (!filled(tenant?.taxId) && !filled(settings.tenantNif)) missing.push("taxId");
  if (!filled(tenant?.legalName)) missing.push("legalName");
  if (!filled(tenant?.street) || !filled(tenant?.postalCode) || !filled(tenant?.city)) missing.push("address");
  return missing;
}

const FIELD_NAMES: Record<IssuerField, string> = {
  taxId: "el NIF",
  legalName: "la razón social",
  address: "la dirección fiscal (calle, código postal y ciudad)",
};

/** "a", "a y b", "a, b y c". */
function spanishList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

/** Where each missing piece is filled in, for the message. */
function whereToFill(missing: IssuerField[]): string {
  const fiscal = missing.includes("taxId") || missing.includes("legalName");
  const salon = missing.includes("address");
  if (fiscal && salon) {
    return "Rellénalos en Ajustes > Cumplimiento fiscal español (NIF y razón social) y en Ajustes > Datos del salón (dirección).";
  }
  if (salon) return "La dirección se rellena en Ajustes > Datos del salón.";
  return `${missing.length > 1 ? "Se rellenan" : "Se rellena"} en Ajustes > Cumplimiento fiscal español.`;
}

/** The Spanish 422 message: what is missing and where to fill it. */
export function issuerIncompleteMessage(missing: IssuerField[]): string {
  const plural = missing.length > 1;
  return (
    `No se puede emitir la factura: ${plural ? "faltan" : "falta"} ${spanishList(missing.map((f) => FIELD_NAMES[f]))} del salón, ` +
    `que ${plural ? "tienen" : "tiene"} que aparecer en todas las facturas. ${whereToFill(missing)}`
  );
}

export class IssuerIncompleteException extends UnprocessableEntityException {
  constructor(readonly missing: IssuerField[]) {
    super({ statusCode: 422, error: "Unprocessable Entity", message: issuerIncompleteMessage(missing), missing });
  }
}

const logger = new Logger("InvoiceIssuer");
let loggedInvalid: string | undefined;

/**
 * The first day ("YYYY-MM-DD") invoices without issuer data are refused, or
 * null (warn only). "2027-01-01" and "2027-01-01T00:00:00Z" both mean that
 * day; anything else is logged once and ignored.
 */
export function issuerBlockFrom(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.INVOICE_ISSUER_BLOCK_FROM?.trim();
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/.exec(raw);
  const day = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  const valid =
    day !== null &&
    !Number.isNaN(Date.parse(raw)) &&
    new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day;
  if (!valid) {
    if (loggedInvalid !== raw) {
      loggedInvalid = raw;
      logger.error(
        `INVOICE_ISSUER_BLOCK_FROM="${raw}" is not an ISO date (YYYY-MM-DD): invoices without issuer data are only warned about, not refused.`,
      );
    }
    return null;
  }
  return day;
}

/** Whether, today in the salon's time zone, invoices without issuer data are refused. */
export function issuerBlocking(
  timeZone: string | null | undefined,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const from = issuerBlockFrom(env);
  return from !== null && salonDay(now, timeZone) >= from;
}

/** What GET /invoices/issuer-status answers. */
export function issuerStatus(
  tenant: (IssuerRow & { timezone?: string | null }) | null,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const missing = issuerMissing(tenant);
  const blockFrom = issuerBlockFrom(env);
  return {
    complete: missing.length === 0,
    missing,
    blockFrom,
    blocking: missing.length > 0 && issuerBlocking(tenant?.timezone, now, env),
    message: missing.length ? issuerIncompleteMessage(missing) : null,
  };
}

/** The issuer problem that refuses an invoice now, or null (complete, or warn only). */
export function issuerProblem(
  tenant: (IssuerRow & { timezone?: string | null }) | null,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): IssuerField[] | null {
  const missing = issuerMissing(tenant);
  if (missing.length === 0 || !issuerBlocking(tenant?.timezone, now, env)) return null;
  return missing;
}

/** What the till says when a sale went through without its invoice for it. */
export function issuerSkippedMessage(missing: IssuerField[]): string {
  const plural = missing.length > 1;
  return (
    `Venta cobrada sin factura: ${plural ? "faltan" : "falta"} ${spanishList(missing.map((f) => FIELD_NAMES[f]))} del salón. ` +
    `${whereToFill(missing)} Después podrás emitir la factura desde Facturas.`
  );
}
