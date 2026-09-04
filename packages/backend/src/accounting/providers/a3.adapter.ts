import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "crypto";
import { AccountingProvider } from "@prisma/client";
import {
  AccountingProviderAdapter,
  OAuthTokens,
  SalesInvoiceInput,
  SalesInvoiceResult,
} from "./provider.interface";

/**
 * A3 (Wolters Kluwer) adapter.
 *
 * Real A3 API:
 *   - WSDL endpoint: https://www.a3software.com/wsdl/Accounting.wsdl
 *   - Auth: user/password WS-Security header (certificate-based in
 *     production; user/password for the SaaS proxy).
 *   - Invoices: `AccountingService.addInvoice` SOAP call.
 *   - Idempotency: A3's `NumeroFactura` field is unique per company.
 *
 * The adapter implements the standard `AccountingProviderAdapter`
 * contract so callers don't need to know about the A3 SOAP envelope.
 * The transport is a stub that produces deterministic responses for
 * CI. To enable real SOAP, set `A3_WSDL_ENDPOINT` and replace
 * `_postToA3Soap` with a SOAP client (e.g. `soap` lib).
 *
 * The authentication is user/password for the SaaS-side proxy (we
 * don't store per-tenant A3 user/passwords). The OAuthTokens shape is
 * kept for interface compatibility but the values are random — the
 * real `accessToken` is the WSSecurity header.
 */
@Injectable()
export class A3Adapter implements AccountingProviderAdapter {
  readonly provider = AccountingProvider.a3;
  private readonly logger = new Logger(A3Adapter.name);
  private readonly e2eMode: string;
  private readonly wsdlEndpoint: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.e2eMode = (
      this.config.get<string>("FISCAL_E2E_MODE") ?? "stub"
    ).toLowerCase();
    this.wsdlEndpoint = this.config.get<string>("A3_WSDL_ENDPOINT");
  }

  getAuthUrl(state: string): string {
    return `/dashboard/settings/accounting?a3-state=${state}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    return {
      accessToken: code,
      refreshToken: "",
      companyId: "",
    };
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    return { accessToken: refreshToken };
  }

  async upsertSalesInvoice(input: SalesInvoiceInput): Promise<SalesInvoiceResult> {
    const response = await this._postToA3Soap(input);
    return {
      externalId: response.id,
      externalUrl: response.url,
    };
  }

  async ping(accessToken: string): Promise<boolean> {
    return Boolean(accessToken);
  }

  private async _postToA3Soap(
    _input: SalesInvoiceInput,
  ): Promise<{ id: string; url?: string }> {
    if (this.e2eMode === "real" && !this.wsdlEndpoint) {
      throw new Error("A3_WSDL_ENDPOINT not configured");
    }
    const stamp = createHash("sha256")
      .update(_input.externalRef)
      .digest("hex")
      .slice(0, 16);
    return { id: `a3-stub-${stamp}`, url: `https://a3.local/factura/${stamp}` };
  }
}
