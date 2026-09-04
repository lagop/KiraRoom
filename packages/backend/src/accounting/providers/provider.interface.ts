import { AccountingProvider } from "@prisma/client";

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  companyId?: string;
}

export interface SalesInvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRate: number;
  /** Product/service identifier in the external system (if known). */
  externalItemId?: string;
}

export interface SalesInvoiceInput {
  /**
   * Our internal invoice id, used as the idempotency key so re-running
   * the sync does not double-book.
   */
  externalRef: string;
  /** ISO date (YYYY-MM-DD) for the document date. */
  issueDate: string;
  /** ISO date or null for the due date (Sage uses this for receivables). */
  dueDate?: string | null;
  /** Customer NIF / VAT number. */
  customerTaxId?: string;
  /** Customer display name. */
  customerName: string;
  /** Customer email if known. */
  customerEmail?: string;
  /** Currency code (ISO 4217). */
  currency: string;
  /** Lines pre-aggregated by the caller. */
  lines: SalesInvoiceLine[];
  /** Notes / description that appear on the document. */
  notes?: string;
}

export interface SalesInvoiceResult {
  externalId: string;
  /** Provider-specific URL to view the document (if available). */
  externalUrl?: string;
}

/**
 * Common contract every accounting provider adapter must satisfy. Both
 * Holded and Sage speak very different APIs but we funnel them through
 * this shape so AccountingService doesn't have to branch per provider.
 */
export interface AccountingProviderAdapter {
  readonly provider: AccountingProvider;
  /**
   * Build the URL the owner is redirected to in order to grant access.
   * `state` is opaque to the provider; we sign it with our CSRF secret
   * so we can validate the callback.
   */
  getAuthUrl(state: string): string;
  /**
   * Exchange the `?code=` from the OAuth callback for access/refresh tokens.
   */
  exchangeCode(code: string): Promise<OAuthTokens>;
  /**
   * Refresh the access token using the stored refresh token.
   */
  refresh(refreshToken: string): Promise<OAuthTokens>;
  /**
   * Upsert a sales invoice. Implementations MUST be idempotent on
   * `input.externalRef` — re-running with the same ref must not create
   * a duplicate document.
   */
  upsertSalesInvoice(input: SalesInvoiceInput): Promise<SalesInvoiceResult>;
  /**
   * Lightweight sanity check that the access token is still valid. Returns
   * true when the provider's `/me` endpoint succeeds.
   */
  ping(accessToken: string): Promise<boolean>;
}