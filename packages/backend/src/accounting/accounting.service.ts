import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AccountingProvider, InvoiceStatus, Prisma } from "@prisma/client";
import { taxRegimeOf } from "@kira/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import {
  HoldedAdapter,
  HoldedApiError,
  HoldedCancelRefused,
  HoldedInvoiceInput,
  HoldedSetupError,
} from "./providers/holded.adapter";

export interface SyncResult {
  status: "synced" | "error" | "pending" | "skipped";
  externalId?: string;
  error?: string;
}

/** Why a sync ran: on issue respects `syncOnIssue`, the others do not. */
export type SyncTrigger = "issue" | "manual" | "retry";

/** Invoices that exist fiscally and belong in the books. */
const SYNCABLE_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.issued,
  InvoiceStatus.paid,
  InvoiceStatus.refunded,
];

/**
 * Automatic retries for transient failures (Holded down, timeout, 429), by
 * number of failures so far. After the last one the invoice is marked
 * `error` and waits for the salon to press "Reintentar".
 */
export const RETRY_DELAYS_MS = [10 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 12 * 3600_000];
export const MAX_AUTO_ATTEMPTS = RETRY_DELAYS_MS.length;

/** What the sync log says when a cancellation could not be mirrored. */
export const CANCEL_NOT_REFLECTED = "No reflejado en Holded: anúlala allí.";

/**
 * Whether cancelling this invoice in KiraRoom has to be mirrored in Holded:
 * it is there (linked), or a push was attempted and may have reached Holded
 * before failing. InvoicesService sets accountingCancelStatus = pending in
 * the same update that cancels the invoice, so a crash in between cannot
 * lose it.
 */
export function cancelNeedsMirror(invoice: {
  accountingExternalId: string | null;
  accountingStatus: string;
}): boolean {
  return !!invoice.accountingExternalId || invoice.accountingStatus === "pending" || invoice.accountingStatus === "error";
}

/** Per manual "send pending" click: Holded allows 60 requests/min on small plans. */
const MANUAL_BATCH = 20;

/**
 * Accounting integration.
 *
 * Holded is the only program with a direct sync: it has a public REST API
 * authenticated with a key the salon generates itself. The salon pastes the
 * key, we keep it encrypted (EncryptionService) in
 * AccountingConnection.encryptedAccessToken and push every issued invoice.
 * The id Holded returns is the one stored; nothing here makes ids up.
 *
 * Sage, A3 and NCS have no API we can use (see InvoiceBookService), so they
 * get the libro de facturas emitidas export instead of a pretend sync.
 */
@Injectable()
export class AccountingService {
  private readonly logger = new Logger(AccountingService.name);
  /**
   * Invoices being pushed right now in this process. The on-issue push, the
   * retry cron and a manual click can meet on the same invoice; this keeps
   * them from creating it twice. (One backend instance; on retries the
   * adapter also checks Holded by number.)
   */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly holded: HoldedAdapter,
  ) {}

  async status(tenantId: string) {
    const [tenant, conn, grouped] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { accountingSettings: true },
      }),
      this.prisma.accountingConnection.findUnique({ where: { tenantId } }),
      this.prisma.invoice.groupBy({
        by: ["accountingStatus"],
        where: { tenantId, status: { in: SYNCABLE_STATUSES } },
        _count: { _all: true },
      }),
    ]);
    const counts = { not_synced: 0, pending: 0, synced: 0, error: 0 } as Record<string, number>;
    for (const g of grouped) counts[g.accountingStatus] = g._count._all;
    const usable = conn && conn.provider === AccountingProvider.holded;
    return {
      syncOnIssue: settingsOf(tenant?.accountingSettings).syncOnIssue !== false,
      connection: usable
        ? {
            provider: conn.provider,
            isActive: conn.isActive,
            connectedAt: conn.createdAt,
            lastSyncAt: conn.lastSyncAt,
            lastError: conn.lastError,
          }
        : null,
      invoices: counts,
    };
  }

  async updateSettings(tenantId: string, patch: { syncOnIssue?: boolean }) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { accountingSettings: true },
    });
    const merged = {
      ...settingsOf(tenant?.accountingSettings),
      ...(patch.syncOnIssue !== undefined ? { syncOnIssue: patch.syncOnIssue } : {}),
    };
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { accountingSettings: merged as Prisma.InputJsonValue },
    });
    return this.status(tenantId);
  }

  /**
   * Stores the salon's Holded API key after checking it against Holded.
   * A key Holded rejects is never saved.
   */
  async connectHolded(tenantId: string, rawKey: string) {
    const apiKey = rawKey.trim();
    try {
      await this.holded.verifyKey(apiKey);
    } catch (err) {
      if (err instanceof HoldedApiError && err.credentialProblem) {
        throw new BadRequestException(
          err.status === 401
            ? "Holded no reconoce esta clave API. Cópiala de nuevo desde Holded > Ajustes > API."
            : "La clave es válida pero le faltan permisos. Dale lectura de impuestos, lectura y escritura de contactos y de facturas de venta.",
        );
      }
      if (err instanceof HoldedApiError && err.transient) {
        throw new ServiceUnavailableException(
          "No hemos podido hablar con Holded ahora mismo. Inténtalo en unos minutos.",
        );
      }
      throw new BadRequestException(`Holded rechazó la clave: ${(err as Error).message}`);
    }

    const data = {
      provider: AccountingProvider.holded,
      encryptedAccessToken: this.encryption.encrypt(apiKey),
      encryptedRefreshToken: null,
      expiresAt: null,
      externalCompanyId: null,
      isActive: true,
      lastError: null,
    };
    const conn = await this.prisma.accountingConnection.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    });
    await this.writeLog({
      tenantId,
      invoiceId: "connection",
      connectionId: conn.id,
      provider: AccountingProvider.holded,
      action: "connect",
      status: "ok",
    });
    return this.status(tenantId);
  }

  async disconnect(tenantId: string): Promise<void> {
    const conn = await this.prisma.accountingConnection.findUnique({ where: { tenantId } });
    if (!conn) return;
    await this.prisma.accountingConnection.delete({ where: { id: conn.id } });
    await this.writeLog({
      tenantId,
      invoiceId: "connection",
      connectionId: null,
      provider: conn.provider,
      action: "unlink",
      status: "ok",
    });
  }

  /**
   * Pushes one invoice to Holded. Never throws for a Holded failure: the
   * outcome lands on the invoice (accountingStatus/accountingError) and in
   * the sync log, and transient failures are left `pending` for the cron.
   *
   * `tenantId`, when given, scopes the lookup (requests from the panel).
   */
  async syncInvoice(
    invoiceId: string,
    opts: { trigger?: SyncTrigger; tenantId?: string } = {},
  ): Promise<SyncResult> {
    const trigger = opts.trigger ?? "issue";
    if (this.inFlight.has(invoiceId)) return { status: "skipped", error: "in_progress" };
    this.inFlight.add(invoiceId);
    try {
      return await this.syncInvoiceUnlocked(invoiceId, trigger, opts.tenantId);
    } finally {
      this.inFlight.delete(invoiceId);
    }
  }

  private async syncInvoiceUnlocked(
    invoiceId: string,
    trigger: SyncTrigger,
    scopeTenantId?: string,
  ): Promise<SyncResult> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, ...(scopeTenantId ? { tenantId: scopeTenantId } : {}) },
      include: {
        lines: true,
        tenant: { select: { accountingSettings: true, fiscalSettings: true } },
      },
    });
    if (!invoice) return { status: "skipped", error: "invoice_not_found" };
    if (invoice.accountingExternalId) {
      return { status: "skipped", externalId: invoice.accountingExternalId };
    }
    if (!SYNCABLE_STATUSES.includes(invoice.status)) {
      return { status: "skipped", error: "not_issued" };
    }

    const conn = await this.prisma.accountingConnection.findUnique({
      where: { tenantId: invoice.tenantId },
    });
    if (!conn || !conn.isActive || conn.provider !== AccountingProvider.holded) {
      // Nothing to sync to. The invoice is still valid fiscally.
      return { status: "skipped", error: "no_connection" };
    }
    if (trigger === "issue" && settingsOf(invoice.tenant?.accountingSettings).syncOnIssue === false) {
      return { status: "skipped", error: "sync_disabled_by_tenant" };
    }

    const fail = async (message: string, retry: boolean, httpStatus: number | null) => {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { accountingStatus: retry ? "pending" : "error", accountingError: message },
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
        payload: { retry, httpStatus, trigger },
      });
      return { status: retry ? "pending" : "error", error: message } as SyncResult;
    };

    if (invoice.series === "R" || invoice.totalCents < 0) {
      // Holded models these as credit notes; we do not send them yet rather
      // than book a rectificativa as an ordinary sale.
      return fail(
        "Las facturas rectificativas no se envían a Holded automáticamente. Regístrala en Holded a mano o pásala a tu gestoría con el libro de facturas.",
        false,
        null,
      );
    }

    let apiKey: string;
    try {
      apiKey = this.encryption.decrypt(conn.encryptedAccessToken);
    } catch {
      return fail("No se pudo leer la clave de Holded guardada. Vuelve a conectar Holded.", false, null);
    }

    const input: HoldedInvoiceInput = {
      documentNumber: `${invoice.series}${invoice.number}`,
      issueDate: invoice.issueDate.toISOString().slice(0, 10),
      currency: invoice.currency,
      customerName: invoice.recipientName,
      customerTaxId: invoice.recipientTaxId,
      notes: invoice.notes,
      regime: taxRegimeOf(invoice.tenant?.fiscalSettings),
      lines: invoice.lines.map((l) => ({
        description: l.description,
        quantity: Number(l.quantity),
        unitPriceCents: l.unitPriceCents,
        discountPct: Number(l.discountPct),
        taxRate: Number(l.taxRate),
      })),
    };

    try {
      // A previous attempt may have reached Holded before failing (timeout):
      // look the number up first so a retry links instead of duplicating.
      const checkExisting = invoice.accountingStatus !== "not_synced";
      const result = await this.holded.pushInvoice(apiKey, input, { checkExisting });
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
        payload: { alreadyInHolded: result.alreadyInHolded, trigger },
      });
      return { status: "synced", externalId: result.externalId };
    } catch (err) {
      this.logger.warn(`syncInvoice(${invoiceId}) failed: ${(err as Error).message}`);
      if (err instanceof HoldedSetupError) return fail(err.message, false, null);
      if (err instanceof HoldedApiError) {
        if (err.credentialProblem) {
          return fail(
            err.status === 401
              ? "Holded ha rechazado la clave API (revocada o cambiada). Vuelve a conectar Holded."
              : `A la clave de Holded le falta un permiso: ${err.detail}`,
            false,
            err.status,
          );
        }
        if (err.transient) {
          return fail(`Holded no está disponible ahora (${err.status || "sin respuesta"}). Se reintentará solo.`, true, err.status);
        }
        return fail(`Holded rechazó la factura: ${err.detail}`, false, err.status);
      }
      // Our own failure (database, bug): worth another go.
      return fail(`Error interno al enviar a Holded: ${(err as Error).message}`, true, null);
    }
  }

  /**
   * Mirrors in Holded the cancellation of an invoice that is (or may be)
   * there: InvoicesService.cancel/anulate mark it `accountingCancelStatus =
   * pending` and call this; the cron retries it. Never throws for a Holded
   * failure. Outcomes land on accountingCancelStatus and in the sync log
   * (action "cancel"):
   *   - cancelled: Holded cancelled it (or it already was, or it is gone);
   *   - pending:   Holded unreachable, retried with the same backoff as
   *                invoice pushes;
   *   - failed:    Holded refused (e.g. already paid there), the key does
   *                not work, or it never answered: the log tells the salon
   *                to cancel it in Holded by hand.
   */
  async reflectCancellation(
    invoiceId: string,
    opts: { trigger?: "cancel" | "retry" } = {},
  ): Promise<SyncResult> {
    if (this.inFlight.has(invoiceId)) return { status: "skipped", error: "in_progress" };
    this.inFlight.add(invoiceId);
    try {
      return await this.reflectCancellationUnlocked(invoiceId, opts.trigger ?? "cancel");
    } finally {
      this.inFlight.delete(invoiceId);
    }
  }

  private async reflectCancellationUnlocked(
    invoiceId: string,
    trigger: "cancel" | "retry",
  ): Promise<SyncResult> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId },
      select: {
        id: true,
        tenantId: true,
        status: true,
        series: true,
        number: true,
        accountingStatus: true,
        accountingExternalId: true,
        accountingCancelStatus: true,
      },
    });
    if (!invoice || invoice.status !== InvoiceStatus.cancelled) {
      return { status: "skipped", error: "not_cancelled" };
    }
    if (invoice.accountingCancelStatus !== "pending") {
      return { status: "skipped", error: "nothing_to_reflect" };
    }

    const conn = await this.prisma.accountingConnection.findUnique({
      where: { tenantId: invoice.tenantId },
    });
    const log = (status: "ok" | "error", extra: { externalId?: string; errorMessage?: string; payload?: Prisma.InputJsonValue }) =>
      this.writeLog({
        tenantId: invoice.tenantId,
        invoiceId,
        connectionId: conn?.id ?? null,
        provider: conn?.provider ?? AccountingProvider.holded,
        action: "cancel",
        status,
        ...extra,
      });
    const settle = async (
      cancelStatus: "pending" | "cancelled" | "failed",
      message: string | null,
      payload: Record<string, unknown>,
    ): Promise<SyncResult> => {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: { accountingCancelStatus: cancelStatus },
      });
      if (cancelStatus === "cancelled") {
        await log("ok", { externalId: invoice.accountingExternalId ?? undefined, payload: { ...payload, trigger } as Prisma.InputJsonValue });
        return { status: "synced", externalId: invoice.accountingExternalId ?? undefined };
      }
      await log("error", {
        externalId: invoice.accountingExternalId ?? undefined,
        errorMessage: message ?? undefined,
        payload: { ...payload, retry: cancelStatus === "pending", trigger } as Prisma.InputJsonValue,
      });
      return { status: cancelStatus === "pending" ? "pending" : "error", error: message ?? undefined };
    };

    if (!conn || !conn.isActive || conn.provider !== AccountingProvider.holded) {
      if (!invoice.accountingExternalId) {
        // Never reached Holded as far as we know, and there is no Holded
        // to ask any more: nothing to mirror.
        await this.prisma.invoice.update({ where: { id: invoice.id }, data: { accountingCancelStatus: null } });
        return { status: "skipped", error: "no_connection" };
      }
      return settle("failed", `${CANCEL_NOT_REFLECTED} (Holded ya no está conectado.)`, { reason: "no_connection" });
    }

    let apiKey: string;
    try {
      apiKey = this.encryption.decrypt(conn.encryptedAccessToken);
    } catch {
      return settle("failed", `${CANCEL_NOT_REFLECTED} (No se pudo leer la clave de Holded guardada.)`, {});
    }

    try {
      let externalId = invoice.accountingExternalId;
      if (!externalId) {
        // A push that failed may still have created it (a timeout after
        // Holded answered): look the number up before deciding it is not there.
        externalId = await this.holded.findInvoiceId(apiKey, `${invoice.series}${invoice.number}`);
        if (!externalId) {
          await this.prisma.invoice.update({
            where: { id: invoice.id },
            data: { accountingCancelStatus: null, accountingStatus: "not_synced", accountingError: null },
          });
          return { status: "skipped", error: "not_in_holded" };
        }
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: { accountingExternalId: externalId, accountingStatus: "synced", accountingError: null },
        });
        invoice.accountingExternalId = externalId;
      }
      const outcome = await this.holded.cancelInvoice(apiKey, externalId);
      return settle("cancelled", null, { outcome });
    } catch (err) {
      this.logger.warn(`reflectCancellation(${invoiceId}) failed: ${(err as Error).message}`);
      if (err instanceof HoldedCancelRefused) {
        return settle("failed", `${CANCEL_NOT_REFLECTED} (Holded no la deja cancelar: ${err.message})`, { httpStatus: 422 });
      }
      if (err instanceof HoldedApiError) {
        if (err.transient) {
          return settle("pending", `Holded no está disponible ahora (${err.status || "sin respuesta"}). Se reintentará la anulación.`, {
            httpStatus: err.status,
          });
        }
        const why = err.credentialProblem ? "Holded ha rechazado la clave API." : `Holded respondió: ${err.detail}`;
        return settle("failed", `${CANCEL_NOT_REFLECTED} (${why})`, { httpStatus: err.status });
      }
      // Our own failure (database, bug): worth another go.
      return settle("pending", `Error interno al anular en Holded: ${(err as Error).message}`, {});
    }
  }

  /**
   * The panel's "Enviar pendientes" button: this salon's invoices that are
   * not in Holded yet. Without `from`, the ones that failed plus everything
   * issued since Holded was connected; with `from`, every invoice issued
   * since that day (to bring in history after connecting).
   */
  async pushPending(tenantId: string, from?: string) {
    const conn = await this.prisma.accountingConnection.findUnique({ where: { tenantId } });
    if (!conn || conn.provider !== AccountingProvider.holded) {
      throw new BadRequestException("Conecta Holded antes de enviar facturas.");
    }
    const where: Prisma.InvoiceWhereInput = {
      tenantId,
      accountingExternalId: null,
      status: { in: SYNCABLE_STATUSES },
      ...(from
        ? { issueDate: { gte: new Date(`${from}T00:00:00.000Z`) } }
        : {
            OR: [
              { accountingStatus: { in: ["pending", "error"] } },
              { createdAt: { gte: conn.createdAt } },
            ],
          }),
    };
    const invoices = await this.prisma.invoice.findMany({
      where,
      select: { id: true },
      orderBy: [{ issueDate: "asc" }, { number: "asc" }],
      take: MANUAL_BATCH,
    });
    const result = { attempted: invoices.length, synced: 0, errors: 0, skipped: 0, remaining: 0 };
    for (const inv of invoices) {
      const r = await this.syncInvoice(inv.id, { trigger: "manual", tenantId });
      if (r.status === "synced") result.synced++;
      else if (r.status === "skipped") result.skipped++;
      else result.errors++;
    }
    result.remaining = await this.prisma.invoice.count({ where });
    return result;
  }

  /**
   * Cron safety net: retries `pending` invoices (transient failures) across
   * tenants with backoff, and gives up into `error` after MAX_AUTO_ATTEMPTS.
   */
  async retryDue(now = new Date(), limit = 50) {
    // A salon that disconnected keeps its pending invoices; they must not
    // hold the queue's first slots forever.
    const connected = {
      accountingConnection: { is: { isActive: true, provider: AccountingProvider.holded } },
    };
    const due = await this.prisma.invoice.findMany({
      where: {
        accountingStatus: "pending",
        accountingExternalId: null,
        // A cancelled invoice is never pushed (syncInvoice skips it without
        // touching the row), so it would sit first in this queue for ever;
        // its cancellation is handled below.
        status: { in: SYNCABLE_STATUSES },
        tenant: connected,
      },
      select: { id: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
    const out = { retried: 0, synced: 0, gaveUp: 0, notDue: 0, cancelsRetried: 0, cancelsGaveUp: 0 };
    for (const inv of due) {
      const failures = await this.recentFailures(inv.id, "sync", now);
      if (failures.length >= MAX_AUTO_ATTEMPTS) {
        await this.prisma.invoice.update({
          where: { id: inv.id },
          data: {
            accountingStatus: "error",
            accountingError: `Holded no respondió tras ${failures.length} intentos. Pulsa "Enviar pendientes" para reintentar.`,
          },
        });
        out.gaveUp++;
        continue;
      }
      if (!this.isDue(failures, now)) {
        out.notDue++;
        continue;
      }
      out.retried++;
      const r = await this.syncInvoice(inv.id, { trigger: "retry" });
      if (r.status === "synced") out.synced++;
    }

    // Cancellations still to mirror in Holded, same backoff.
    const cancels = await this.prisma.invoice.findMany({
      where: { accountingCancelStatus: "pending", status: InvoiceStatus.cancelled, tenant: connected },
      select: { id: true, tenantId: true, accountingExternalId: true },
      orderBy: { updatedAt: "asc" },
      take: limit,
    });
    for (const inv of cancels) {
      const failures = await this.recentFailures(inv.id, "cancel", now);
      if (failures.length >= MAX_AUTO_ATTEMPTS) {
        await this.prisma.invoice.update({
          where: { id: inv.id },
          data: { accountingCancelStatus: "failed" },
        });
        await this.writeLog({
          tenantId: inv.tenantId,
          invoiceId: inv.id,
          connectionId: null,
          provider: AccountingProvider.holded,
          action: "cancel",
          status: "error",
          externalId: inv.accountingExternalId ?? undefined,
          errorMessage: `${CANCEL_NOT_REFLECTED} (Holded no respondió tras ${failures.length} intentos.)`,
          payload: { retry: false, trigger: "retry", gaveUp: true },
        });
        out.cancelsGaveUp++;
        continue;
      }
      if (!this.isDue(failures, now)) {
        out.notDue++;
        continue;
      }
      out.cancelsRetried++;
      await this.reflectCancellation(inv.id, { trigger: "retry" });
    }
    return out;
  }

  /** This invoice's failed attempts of `action` in the last 48 hours, newest first. */
  private recentFailures(invoiceId: string, action: "sync" | "cancel", now: Date) {
    return this.prisma.accountingSyncLog.findMany({
      where: { invoiceId, action, status: "error", createdAt: { gte: new Date(now.getTime() - 48 * 3600_000) } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
  }

  private isDue(failures: { createdAt: Date }[], now: Date): boolean {
    const last = failures[0]?.createdAt;
    const delay = RETRY_DELAYS_MS[Math.max(0, failures.length - 1)];
    return !last || now.getTime() - last.getTime() >= delay;
  }

  async recentLogs(tenantId: string, limit = 100) {
    return this.prisma.accountingSyncLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 200),
      select: {
        id: true,
        invoiceId: true,
        provider: true,
        action: true,
        status: true,
        externalId: true,
        errorMessage: true,
        createdAt: true,
      },
    });
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
    payload?: Prisma.InputJsonValue;
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
        payload: input.payload ?? Prisma.JsonNull,
      },
    });
  }
}

function settingsOf(raw: unknown): { syncOnIssue?: boolean } & Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}
