import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EmailService } from "../../notifications/services/email.service";

/**
 * In-process retry scheduler for fiscal Spain dispatches.
 *
 * This implementation does NOT depend on Bull/Redis — it uses
 * `setTimeout` because we don't want to add a Redis dependency for
 * production-not-yet customers. The interface is shaped so it can be
 * swapped for a Bull-backed implementation in F6 production-hardening
 * without touching callers.
 *
 * Backoff schedule:
 *   1st failure → 5 min
 *   2nd          → 30 min
 *   3rd          → 2 h
 * After 3 attempts we mark `fiscalStatus='error'` and email the owner.
 */
export const FISCAL_RETRY_DELAYS_MS = [
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
];
export const FISCAL_RETRY_MAX_ATTEMPTS = 3;

export type FiscalDispatchFn = (invoiceId: string) => Promise<{
  status: "accepted" | "rejected" | "error" | "needs_refresh" | "skipped";
  error?: string;
  externalId?: string;
}>;

@Injectable()
export class FiscalRetryQueue {
  private readonly logger = new Logger(FiscalRetryQueue.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /**
   * Set at module-init time by InvoicesModule so the worker can call
   * back into the fiscal pipeline.
   */
  private dispatchFn: FiscalDispatchFn = async () => ({
    status: "skipped",
  });

  bindDispatchFn(fn: FiscalDispatchFn): void {
    this.dispatchFn = fn;
  }

  /**
   * Enqueue the next retry. The actual dispatch runs after `delayMs`;
   * on a fresh failure we re-enqueue the next slot.
   */
  async schedule(
    invoiceId: string,
    attempt: number,
    delayMs: number,
    lastError?: string,
  ): Promise<void> {
    this.logger.warn(
      `Fiscal retry scheduled: invoice=${invoiceId} attempt=${attempt + 1} ` +
        `delay=${Math.round(delayMs / 1000)}s`,
    );
    // Bump the counter so the dashboard reflects the in-flight retry.
    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { fiscalRetryCount: attempt + 1 },
    });
    // Capture for the closure.
    const fn = this.dispatchFn;
    const prisma = this.prisma;
    const email = this.email;
    setTimeout(async () => {
      try {
        const result = await fn(invoiceId);
        if (result.status === "accepted") {
          return;
        }
        if (attempt + 1 >= FISCAL_RETRY_MAX_ATTEMPTS) {
          await FiscalRetryQueue.markPermanentAndEmail(
            prisma,
            email,
            invoiceId,
            result.error ?? lastError,
          );
          return;
        }
        await this.schedule(
          invoiceId,
          attempt + 1,
          FISCAL_RETRY_DELAYS_MS[attempt + 1] ?? FISCAL_RETRY_DELAYS_MS.at(-1)!,
          result.error ?? lastError,
        );
      } catch (err) {
        this.logger.warn(
          `Fiscal retry crash for ${invoiceId}: ${(err as Error).message}`,
        );
      }
    }, delayMs);
  }

  /**
   * Convenience: pick the right delay for the next attempt.
   */
  static nextDelayMs(nextAttempt: number): number {
    return FISCAL_RETRY_DELAYS_MS[nextAttempt] ?? FISCAL_RETRY_DELAYS_MS.at(-1)!;
  }

  /**
   * Mark an invoice permanently failed and email the owner.
   * Exposed as static so the worker can call it without holding a `this`.
   */
  static async markPermanentAndEmail(
    prisma: PrismaService,
    email: EmailService,
    invoiceId: string,
    lastError?: string,
  ): Promise<void> {
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        fiscalStatus: "error",
        fiscalError: lastError ?? "Permanent error after retries",
        fiscalRetryCount: FISCAL_RETRY_MAX_ATTEMPTS,
      },
    });
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        tenant: { select: { name: true, email: true, id: true } },
      },
    });
    if (!invoice?.tenant.email) return;
    try {
      await email.sendEmail({
        to: invoice.tenant.email,
        subject: `Factura ${invoice.series}${invoice.number} rechazada por AEAT`,
        html: `<p>Tu factura <strong>${invoice.series}${invoice.number}</strong> de ${invoice.tenant.name} fue rechazada tras ${FISCAL_RETRY_MAX_ATTEMPTS} intentos.</p>
<p>Detalle: ${lastError ?? ""}</p>
<p>Resolver desde el dashboard: <a href="https://app.kirastudio.com/dashboard/billing/invoices/${invoiceId}">abrir factura</a></p>`,
      });
    } catch (err) {
      // Email is best-effort; keep the invoice marked permanent.
    }
  }
}
