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
 * NCS (Spanish accounting software) adapter.
 *
 * Real NCS API:
 *   - WSDL endpoint: https://www.ncs.es/wsdl/AccountingService.wsdl
 *   - Auth: WSSecurity with a per-customer certificate issued by NCS.
 *   - Invoices: `InsertarFactura` SOAP call.
 *   - Idempotency: NCS's `NumFacturaCompleto` is unique per company.
 *
 * The transport is a stub that produces deterministic responses for
 * CI. To enable real SOAP, set `NCS_WSDL_ENDPOINT` and replace
 * `_postToNcsSoap` with a SOAP client.
 */
@Injectable()
export class NCSAdapter implements AccountingProviderAdapter {
  readonly provider = AccountingProvider.ncs;
  private readonly logger = new Logger(NCSAdapter.name);
  private readonly e2eMode: string;
  private readonly wsdlEndpoint: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.e2eMode = (
      this.config.get<string>("FISCAL_E2E_MODE") ?? "stub"
    ).toLowerCase();
    this.wsdlEndpoint = this.config.get<string>("NCS_WSDL_ENDPOINT");
  }

  getAuthUrl(state: string): string {
    return `/dashboard/settings/accounting?ncs-state=${state}`;
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
    const response = await this._postToNcsSoap(input);
    return {
      externalId: response.id,
      externalUrl: response.url,
    };
  }

  async ping(accessToken: string): Promise<boolean> {
    return Boolean(accessToken);
  }

  private async _postToNcsSoap(
    _input: SalesInvoiceInput,
  ): Promise<{ id: string; url?: string }> {
    if (this.e2eMode === "real" && !this.wsdlEndpoint) {
      throw new Error("NCS_WSDL_ENDPOINT not configured");
    }
    const stamp = createHash("sha256")
      .update(_input.externalRef)
      .digest("hex")
      .slice(0, 16);
    return { id: `ncs-stub-${stamp}`, url: `https://ncs.local/factura/${stamp}` };
  }
}
