/**
 * The salon's data as the issuer of its invoices (NIF, razón social, fiscal
 * address): mandatory on every invoice. GET /invoices/issuer-status says
 * what is missing; the panel warns the owner and admins until it is filled
 * in (IssuerDataBanner). From the date the backend has in
 * INVOICE_ISSUER_BLOCK_FROM, invoices without it are refused; a sale at the
 * till still goes through, without its invoice.
 */

export type IssuerField = "taxId" | "legalName" | "address";

export interface InvoiceIssuerStatus {
  complete: boolean;
  missing: IssuerField[];
  /** "YYYY-MM-DD" from which invoices without it are refused, or null (warn only). */
  blockFrom: string | null;
  /** Refused already. */
  blocking: boolean;
  /** The backend's Spanish message. */
  message: string | null;
}

/** Where each missing piece is filled in. */
export function issuerLinks(missing: IssuerField[]): Array<{ href: string; label: "linkFiscal" | "linkSalon" }> {
  const links: Array<{ href: string; label: "linkFiscal" | "linkSalon" }> = [];
  if (missing.includes("taxId") || missing.includes("legalName")) {
    links.push({ href: "/dashboard/settings/fiscal", label: "linkFiscal" });
  }
  if (missing.includes("address")) links.push({ href: "/dashboard/settings/salon", label: "linkSalon" });
  return links;
}

/** "a", "a y b", "a, b y c" (with the language's "and"). */
export function joinList(items: string[], and: string): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
}

/** "2027-01-01" as "01/01/2027". */
export function issuerBlockDate(day: string): string {
  const [y, m, d] = day.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** Whether to show the banner, and in which tone. */
export function issuerBannerState(status: InvoiceIssuerStatus | null | undefined): "none" | "warn" | "scheduled" | "blocking" {
  if (!status || status.complete || status.missing.length === 0) return "none";
  if (status.blocking) return "blocking";
  return status.blockFrom ? "scheduled" : "warn";
}
