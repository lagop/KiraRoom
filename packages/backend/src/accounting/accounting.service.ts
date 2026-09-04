import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import { AccountingProvider } from "@prisma/client";
import { HoldedAdapter, ProviderHttpError } from "./providers/holded.adapter";
import { SageAdapter } from "./providers/sage.adapter";
import {
  AccountingProviderAdapter,
  SalesInvoiceInput,
} from "./providers/provider.interface";

export interface SyncResult {
  status: "synced" | "error" | "skipped" | "needs_refresh";
  externalId?: string;
  error?: string;
}

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000]; // 1m, 5m, 30m
const MAX_RETRIES = 5;

@Injectable()
export class AccountingService {
  private readonly logger = new Logger(AccountingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly holded: HoldedAdapter,
    private readonly sage: SageAdapter,
  ) {}

  /** Test seam: swap adapter implementations per provider. */
  private adapterFor(provider: AccountingProvider): AccountingProviderAdapter {
    return provider === AccountingProvider.holded ? this.holded : this.sage;
  }

  /**
   * Build the OAuth URL for the given provider. The `state` is a signed
   * HMAC of (tenantId, provider, nonce) so the callback can verify the
   * request wasn't forged.
   */
  buildAuthUrl(
    provider: AccountingProvider,
    tenantId: string,
    secret: string,
  ): { url: string; state: string } {
    const nonce = Math.random().toString(36).slice(2, 14);
    const payload = `${tenantId}|${provider}|${nonce}`;
    const sig = this.encryption.hmac(payload, secret);
    const state = `${Buffer.from(payload).toString("base64url")}.${sig}`;
    return { url: this.adapterFor(provider).getAuthUrl(state), state };
  }

  async completeOAuth(
    provider: AccountingProvider,
    tenantId: string,
    code: string,
    secret: string,
  ): Promise<{ id: string }> {
    const adapter = this.adapterFor(provider);
    const tokens = await adapter.exchangeCode(code);

    const existing = await this.prisma.accountingConnection.findUnique({
      where: { tenantId },
    });
    const data = {
      tenantId,
      provider,
      encryptedAccessToken: this.encryption.encrypt(tokens.accessToken),
      encryptedRefreshToken: tokens.refreshToken
        ? this.encryption.encrypt(tokens.refreshToken)
        : existing?.encryptedRefreshToken ?? null,
      expiresAt: tokens.expiresAt ?? null,
      externalCompanyId: tokens.companyId ?? existing?.externalCompanyId ?? null,
      isActive: true,
      lastError: null,
    };

    const conn = existing
      ? await this.prisma.accountingConnection.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.accountingConnection.create({ data });

    await this.writeLog({
      tenantId,
      invoiceId: "oauth",
      connectionId: conn.id,
      provider,
      action: "sync",
      status: "ok",
      externalId: tokens.companyId,
      payload: { event: "oauth_completed" },
    });
    return { id: conn.id };
  }

  async disconnect(tenantId: string): Promise<void> {
    const conn = await this.prisma.accountingConnection.findUnique({
      where: { tenantId },
    });
    if (!conn) return;
    await this.prisma.accountingConnection.delete({ where: { id: conn.id } });
    await this.writeLog({
      tenantId,
      invoiceId: "disconnect",
      connectionId: null,
      provider: conn.provider,
      action: "unlink",
      status: "ok",
      payload: null,
    });
  }

  /**
   * Sync a single Invoice to the accounting provider. Idempotent on
   * `Invoice.accountingExternalId` — re-running returns the existing
   * record.
   */
  async syncInvoice(invoiceId: string): Promise<SyncResult> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        lines: true,
        tenant: { select: { accountingSettings: true } },
      },
    });
    if (!invoice) {
      return { status: "skipped", error: "invoice_not_found" };
    }

    const conn = await this.prisma.accountingConnection.findUnique({
      where: { tenantId: invoice.tenantId },
    });
    if (!conn || !conn.isActive) {
      // No connection — silently skip. The invoice is still valid fiscally.
      return { status: "skipped", error: "no_connection" };
    }

    // Idempotency short-circuit: if we already have an externalId, skip.
    if (invoice.accountingExternalId) {
      await this.writeLog({
        tenantId: invoice.tenantId,
        invoiceId,
        connectionId: conn.id,
        provider: conn.provider,
        action: "sync",
        status: "skipped",
        externalId: invoice.accountingExternalId,
        payload: { reason: "already_synced" },
      });
      return { status: "skipped", externalId: invoice.accountingExternalId };
    }

    // Gate on tenant settings: if syncOnIssue is disabled, skip.
    const settings =
      ((invoice.tenant?.accountingSettings as unknown as Record<string, unknown>) ?? {}) as Record<string, unknown>;
    if (settings.syncOnIssue === false) {
      return { status: "skipped", error: "sync_disabled_by_tenant" };
    }

    const tokens = await this.getValidTokens(conn);
    if (!tokens.ok) {
      return { status: "needs_refresh", error: tokens.error };
    }
    void tokens.accessToken; // currently unused — kept for adapter signature

    const adapter = this.adapterFor(conn.provider);
    const input: SalesInvoiceInput = this.buildSalesInvoiceInput(invoice);

    try {
      const result = await adapter.upsertSalesInvoice(input);
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          accountingExternalId: result.externalId,
          accountingSyncedAt: new Date(),
          accountingStatus: "synced",
          accountingError: null,
        },
      });
      await this.prisma.accountingConnection.update({
        where: { id: conn.id },
        data: { lastSyncAt: new Date(), lastError: null },
      });
      await this.writeLog({
        tenantId: invoice.tenantId,
        invoiceId,
        connectionId: conn.id,
        provider: conn.provider,
        action: "sync",
        status: "ok",
        externalId: result.externalId,
        payload: { externalUrl: result.externalUrl },
      });
      return { status: "synced", externalId: result.externalId };
    } catch (err) {
      const isHttpErr = err instanceof ProviderHttpError;
      const message = (err as Error).message;
      this.logger.warn(
        `syncInvoice(${invoiceId}) failed: ${message}`,
      );
      const shouldRetry =
        !isHttpErr || (isHttpErr && (err as ProviderHttpError).status >= 500);
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          accountingStatus: shouldRetry ? "pending" : "error",
          accountingError: message,
        },
      });
      await this.prisma.accountingConnection.update({
        where: { id: conn.id },
        data: { lastError: message },
      });
      await this.writeLog({
        tenantId: invoice.tenantId,
        invoiceId,
        connectionId: conn.id,
        provider: conn.provider,
        action: "sync",
        status: "error",
        errorMessage: message,
        payload: { retry: shouldRetry, status: isHttpErr ? (err as ProviderHttpError).status : null },
      });
      return { status: "error", error: message };
    }
  }

  /**
   * Drain the queue of all unsynced invoices across all tenants.
   * Intended to be called from a cron every 30 min as a safety net.
   */
  async retryQueue(limit = 50): Promise<{
    attempted: number;
    synced: number;
    skipped: number;
    errors: number;
  }> {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        accountingStatus: "pending",
        accountingExternalId: null,
      },
      take: limit,
      orderBy: { updatedAt: "asc" },
    });
    let synced = 0;
    let skipped = 0;
    let errors = 0;
    for (const inv of invoices) {
      const result = await this.syncInvoice(inv.id);
      if (result.status === "synced") synced++;
      else if (result.status === "skipped") skipped++;
      else errors++;
    }
    return {
      attempted: invoices.length,
      synced,
      skipped,
      errors,
    };
  }

  /** Exposed for tests / cron callers — list recent logs. */
  async recentLogs(tenantId: string, limit = 100) {
    return this.prisma.accountingSyncLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 200),
    });
  }

  // ---- helpers ----

  private async getValidTokens(conn: {
    encryptedAccessToken: string;
    encryptedRefreshToken: string | null;
    expiresAt: Date | null;
    provider: AccountingProvider;
    tenantId: string;
  }): Promise<
    | { ok: true; accessToken: string; error?: undefined }
    | { ok: false; accessToken?: undefined; error: string }
  > {
    // 60-second safety window: refresh if the token expires within a minute.
    const expiresAt = conn.expiresAt;
    const needsRefresh =
      !expiresAt ||
      expiresAt.getTime() - Date.now() < 60_000;

    if (!needsRefresh) {
      try {
        return {
          ok: true,
          accessToken: this.encryption.decrypt(conn.encryptedAccessToken),
        };
      } catch (err) {
        return { ok: false, error: `decrypt_failed: ${(err as Error).message}` };
      }
    }
    if (!conn.encryptedRefreshToken) {
      return { ok: false, error: "no_refresh_token" };
    }
    try {
      const refresh = this.encryption.decrypt(conn.encryptedRefreshToken);
      const adapter = this.adapterFor(conn.provider);
      const tokens = await adapter.refresh(refresh);
      await this.prisma.accountingConnection.update({
        where: { tenantId: conn.tenantId },
        data: {
          encryptedAccessToken: this.encryption.encrypt(tokens.accessToken),
          encryptedRefreshToken: tokens.refreshToken
            ? this.encryption.encrypt(tokens.refreshToken)
            : conn.encryptedRefreshToken,
          expiresAt: tokens.expiresAt ?? null,
        },
      });
      return { ok: true, accessToken: tokens.accessToken };
    } catch (err) {
      return { ok: false, error: `refresh_failed: ${(err as Error).message}` };
    }
  }

  private buildSalesInvoiceInput(invoice: any): SalesInvoiceInput {
    return {
      externalRef: `${invoice.tenantId.slice(0, 8)}-${invoice.series}${invoice.number}`,
      issueDate: invoice.issueDate.toISOString().slice(0, 10),
      customerTaxId: invoice.recipientTaxId ?? undefined,
      customerName: invoice.recipientName,
      customerEmail: undefined,
      currency: invoice.currency,
      lines: invoice.lines.map((l: any) => ({
        description: l.description,
        quantity: Number(l.quantity),
        unitPriceCents: l.unitPriceCents,
        taxRate: Number(l.taxRate),
      })),
      notes: invoice.notes ?? undefined,
    };
  }

  private async writeLog(input: {
    tenantId: string;
    invoiceId: string;
    connectionId: string | null;
    provider: AccountingProvider;
    action: string;
    status: string;
    externalId?: string;
    errorMessage?: string;
    payload?: any;
  }): Promise<void> {
    await this.prisma.accountingSyncLog.create({
      data: {
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        provider: input.provider,
        action: input.action,
        status: input.status,
        externalId: input.externalId ?? null,
        errorMessage: input.errorMessage ?? null,
        connectionId: input.connectionId,
        payload: input.payload ?? null,
      },
    });
  }
}