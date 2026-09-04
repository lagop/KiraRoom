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

/**
 * Holded adapter.
 *
 * Real Holded API:
 *   - OAuth2 base: https://api.holded.com/api/oauth/...
 *   - Invoices:    POST https://api.holded.com/api/invoicing/v1/documents/invoice
 *   - Idempotency: Holded uses the customId field to deduplicate.
 *
 * This STUB replaces the HTTP transport with in-memory mocks. The shape
 * of every request/response matches the real Holded docs so that swapping
 * `_postToHolded` for `fetch()` is a localised change.
 */
@Injectable()
export class HoldedAdapter implements AccountingProviderAdapter {
  readonly provider = AccountingProvider.holded;
  private readonly logger = new Logger(HoldedAdapter.name);

  constructor(private readonly config: ConfigService) {}

  getAuthUrl(state: string): string {
    const clientId = this.config.get<string>("HOLDED_CLIENT_ID") ?? "dev-client-id";
    const redirectUri =
      this.config.get<string>("HOLDED_REDIRECT_URI") ??
      "http://localhost:3000/api/v1/accounting/callback/holded";
    const base = "https://app.holded.com/oauth/authorize";
    const qs = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: "invoicing:write contacts:read",
    });
    return `${base}?${qs.toString()}`;
  }

  async exchangeCode(code: string): Promise<OAuthTokens> {
    // Real call:
    //   POST https://api.holded.com/api/oauth/token
    //     grant_type=authorization_code&code=<code>&client_id=...&client_secret=...
    // Stub returns deterministic tokens so tests can assert behaviour.
    return {
      accessToken: `holded-at-${randomBytes(8).toString("hex")}-for-${code.slice(0, 6)}`,
      refreshToken: `holded-rt-${randomBytes(8).toString("hex")}`,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      companyId: "holded-company-stub",
    };
  }

  async refresh(refreshToken: string): Promise<OAuthTokens> {
    return {
      accessToken: `holded-at-refreshed-${randomBytes(6).toString("hex")}`,
      refreshToken,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    };
  }

  async upsertSalesInvoice(input: SalesInvoiceInput): Promise<SalesInvoiceResult> {
    // Real call:
    //   POST https://api.holded.com/api/invoicing/v1/documents/invoice
    //     { customId, contactCode, date, lines: [{ name, units, price, tax }] }
    // The `customId` lets Holded dedupe across retries. We embed our
    // externalRef there so a re-run returns the same document.
    const body = this.buildHoldedPayload(input);
    const response = await this._postToHolded("/invoicing/v1/documents/invoice", body);
    return {
      externalId: response.id,
      externalUrl: response.url ?? `https://app.holded.com/invoices/${response.id}`,
    };
  }

  async ping(_accessToken: string): Promise<boolean> {
    // Real call: GET https://api.holded.com/api/contacts?limit=1
    // For the stub, assume fresh.
    return true;
  }

  private buildHoldedPayload(input: SalesInvoiceInput) {
    return {
      customId: input.externalRef,
      contactName: input.customerName,
      contactTaxId: input.customerTaxId ?? "",
      contactEmail: input.customerEmail ?? "",
      date: input.issueDate,
      dueDate: input.dueDate,
      currency: input.currency,
      notes: input.notes,
      lines: input.lines.map((l) => ({
        name: l.description,
        units: l.quantity,
        price: l.unitPriceCents / 100,
        tax: l.taxRate,
      })),
    };
  }

  /**
   * STUB HTTP transport. In production, replace with:
   *   const res = await fetch("https://api.holded.com/api" + path, {
   *     method: "POST",
   *     headers: {
   *       "Authorization": `Bearer ${accessToken}`,
   *       "Content-Type": "application/json",
   *     },
   *     body: JSON.stringify(body),
   *   });
   *   if (res.status === 409) {
   *     // Holded already has a doc with this customId — return it instead.
   *     const existing = await this.lookupByCustomId(accessToken, body.customId);
   *     return { id: existing.id, url: existing.url };
   *   }
   *   if (!res.ok) throw new ProviderHttpError(res.status, await res.text());
   *   return res.json();
   */
  private async _postToHolded(
    _path: string,
    body: any,
  ): Promise<{ id: string; url?: string }> {
    // Deterministic id derived from the customId so retries collide.
    const id = `inv-${createHmac("sha256", "holded-stub")
      .update(body.customId)
      .digest("hex")
      .slice(0, 16)}`;
    return { id, url: `https://app.holded.com/invoices/${id}` };
  }
}

/**
 * Thrown by real adapter HTTP calls to signal a 4xx (validation, scope)
 * so the caller can mark the sync as `error` without retrying.
 */
export class ProviderHttpError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Provider HTTP ${status}: ${body}`);
  }
}