import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac, randomBytes } from "crypto";
import { AccountingProvider } from "@prisma/client";
import {
  AccountingProviderAdapter,
  OAuthTokens,
  SalesInvoiceInput,
  SalesInvoiceResult,
} from "./provider.interface";
import { ProviderHttpError } from "./holded.adapter";

/**
 * Sage Despachos Connected / Sage 200 adapter.
 *
 * Real Sage APIs vary by product:
 *   - Sage Despachos Connected: REST with OAuth2 bearer.
 *   - Sage 200: SOAP with WS-Security.
 *
 * This STUB targets the REST flavour (more common for SMBs). The shape
 * of every request/response matches Sage's documented conventions.
 *
 * Idempotency: Sage uses the document number + series to dedupe, so we
 * pass our `externalRef` as both the `document_number` and `external_ref`
 * fields. A re-run returns the same id.
 */
@Injectable()
export class SageAdapter implements AccountingProviderAdapter {
  readonly provider = AccountingProvider.sage;
  private readonly logger = new Logger(SageAdapter.name);

  constructor(private readonly config: ConfigService) {}

  getAuthUrl(state: string): string {
    const clientId = this.config.get<string>("SAGE_CLIENT_ID") ?? "dev-client-id";
    const redirectUri =
      this.config.get<string>("SAGE_REDIRECT_URI") ??
      "http://localhost:3000/api/v1/accounting/callback/sage";
    const base = "https://www.sageone.es/oauth/authorize";
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: "sales_invoices:write contacts:read",
    });
    return `${base}?${qs.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    return {
      accessToken: `sage-at-${randomBytes(8).toString("hex")}-for-${code.slice(0, 6)}`,
      refreshToken: `sage-rt-${randomBytes(8).toString("hex")}`,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      companyId: "sage-company-stub",
    };
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    return {
      accessToken: `sage-at-refreshed-${randomBytes(6).toString("hex")}`,
      refreshToken,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    };
  }

  async upsertSalesInvoice(input: SalesInvoiceInput): Promise<SalesInvoiceResult> {
    const body = this.buildSagePayload(input);
    const response = await this._postToSage("/sales_invoices", body);
    return {
      externalId: response.id,
      externalUrl: response.url ?? `https://app.sageone.es/invoices/${response.id}`,
    };
  }

  async ping(_accessToken: string): Promise<boolean> {
    return true;
  }

  private buildSagePayload(input: SalesInvoiceInput) {
    return {
      // Sage-specific fields
      external_ref: input.externalRef,
      document_number: input.externalRef,
      document_type: "sales_invoice",
      contact: {
        name: input.customerName,
        tax_id: input.customerTaxId ?? "",
        email: input.customerEmail ?? "",
      },
      issue_date: input.issueDate,
      due_date: input.dueDate,
      currency: input.currency,
      notes: input.notes,
      // Lines use tax_rate (Holded used tax). Each adapter is responsible
      // for mapping to its provider's shape — never reuse Holded payloads.
      items: input.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unitPriceCents / 100,
        tax_rate: l.taxRate,
      })),
    };
  }

  /**
   * STUB HTTP transport. In production, replace with a fetch() to
   * https://api.sageone.es/v1 + path, with `Authorization: Bearer ${token}`.
   * Note Sage returns the document id on 201 and the existing id on 200
   * (idempotent semantics) — the stub replicates that.
   */
  private async _postToSage(
    _path: string,
    body: any,
  ): Promise<{ id: string; url?: string }> {
    const id = `sage-${createHmac("sha256", "sage-stub")
      .update(body.external_ref)
      .digest("hex")
      .slice(0, 16)}`;
    return { id, url: `https://app.sageone.es/sales_invoices/${id}` };
  }
}