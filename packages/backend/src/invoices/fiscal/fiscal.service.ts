import { Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { VerifactuService } from "./verifactu.service";
import { TicketBaiService } from "./ticketbai.service";
import { SiiService } from "./sii.service";
import { FiscalRetryQueue } from "./fiscal-retry.queue";
import { FiscalMode, Invoice, InvoiceFiscalStatus } from "@prisma/client";
import { createHash } from "crypto";

export interface FiscalDispatchInput {
  invoiceId: string;
}

/**
 * Builds the canonical AEAT `<Huella>` per RD 1007/2023 + Verifactu spec.
 * Order is strict; do not reorder. The first record in the chain uses an
 * empty `huellaAnterior` so the join character is omitted.
 *
 * Input fields:
 *  - NIF emisor
 *  - NumSerieFactura (= series + number without separator)
 *  - FechaExpedicionFactura (YYYY-MM-DD)
 *  - TipoFactura (F1, R1, etc â€” let AEAT assign)
 *  - CuotaRepercutida (sum of tax)
 *  - ImporteTotal
 *  - HuellaAnterior (hex from previous dispatch)
 */
export function buildVerifactuHuella(input: {
  tenantNif: string;
  invoiceNumber: string;
  issueDate: string;
  totalTaxCents: number;
  totalCents: number;
  previousHash: string | null;
}): string {
  const orden = [
    input.previousHash ?? "",
    input.tenantNif,
    input.invoiceNumber,
    input.issueDate,
    input.totalTaxCents.toFixed(2),
    input.totalCents.toFixed(2),
    // Addicional fields omitted for MVP: tipoFactura, cuotaTotal,
    // huellas anteriores adicionales, datos derechos emittedos â€” los
    // incorporamos en F+1 si el integrador AEAT los requiere.
  ].join("|");
  return createHash("sha256").update(orden).digest("hex");
}

/**
 * Builds the canonical TicketBAI huella per Bizkaia spec v1.2.
 */
export function buildTicketBaiHuella(input: {
  tenantNif: string;
  invoiceNumber: string;
  issueDate: string;
  totalTaxCents: number;
  totalCents: number;
  previousHash: string | null;
}): string {
  // TBAI ordena por: NIF, numfactura, fecha, tipo, cuota, importe,
  // huellaAnterior. El campo "tipo" depende del rÃ©gimen; por defecto "F".
  const orden = [
    input.tenantNif,
    input.invoiceNumber,
    input.issueDate,
    "F",
    input.totalTaxCents.toFixed(2),
    input.totalCents.toFixed(2),
    input.previousHash ?? "",
  ].join("&");
  return createHash("sha256").update(orden).digest("hex");
}

/**
 * Orchestrates the fiscal pipeline. Reads tenant configuration, decides
 * which regime applies, computes the chain hash, dispatches, and writes
 * the FiscalChainState for the next submission.
 */
@Injectable()
export class FiscalService {
  private readonly logger = new Logger(FiscalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly verifactu: VerifactuService,
    private readonly ticketBai: TicketBaiService,
    private readonly sii: SiiService,
    @Optional() private readonly retryQueue?: FiscalRetryQueue,
    @Optional() private readonly invoiceServiceRef?: any,
  ) {}

  /**
   * Dispatch an invoice through its configured fiscal pipeline. Idempotent
   * per (tenantId, fiscalMode) chain â€” once a hash is recorded, re-runs
   * are no-ops.
   */
  async dispatchInvoice(invoiceId: string): Promise<void> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        tenant: { select: { fiscalMode: true, fiscalSettings: true } },
      },
    });
    if (!invoice) return;
    const mode: FiscalMode = invoice.tenant.fiscalMode;
    if (mode === FiscalMode.none) return;
    if (invoice.fiscalStatus === InvoiceFiscalStatus.accepted) return;

    await this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { fiscalStatus: InvoiceFiscalStatus.pending, fiscalError: null },
    });

    switch (mode) {
      case FiscalMode.verifactu:
        await this.dispatchVerifactu(invoice);
        break;
      case FiscalMode.ticketbai:
        await this.dispatchTicketBai(invoice);
        break;
      case FiscalMode.sii_only:
        await this.dispatchSii(invoice);
        break;
      default:
        this.logger.warn(`Unhandled fiscalMode ${mode}`);
    }
  }

  /**
   * Same as dispatchInvoice but emits the `<RegistroAnulacion>`
   * envelope per AEAT / TBAI spec instead of `<RegistroAlta>`.
   *
   * Sign + dispatch + persist. The dispatch goes through the regular
   * retry queue when the AEAT/diputación returns 5xx; 4xx validation
   * failures are persisted as permanent.
   */
  async anulateInvoice(invoiceId: string, _reason: string): Promise<boolean> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        tenant: { select: { fiscalMode: true, fiscalSettings: true } },
      },
    });
    if (!invoice) return false;
    const mode: FiscalMode = invoice.tenant.fiscalMode;
    if (mode === FiscalMode.none) {
      // No-op — local cancel already handled by InvoiceService.cancel.
      return true;
    }
    const settings = (invoice.tenant.fiscalSettings as Record<string, unknown>) ?? {};
    const tenantNif = (settings.tenantNif as string) ?? invoice.issuerTaxIdAtIssue ?? "";

    const chainState = await this.prisma.fiscalChainState.findUnique({
      where: {
        tenantId_fiscalMode: {
          tenantId: invoice.tenantId,
          fiscalMode: mode,
        },
      },
    });
    const previousHash = chainState?.lastHash ?? null;
    const issueDate = invoice.issueDate.toISOString().slice(0, 10);
    const invoiceNumber = `${invoice.series}${invoice.number}`;

    let xml: string;
    try {
      if (mode === FiscalMode.verifactu) {
        xml = this.verifactu.buildAnulateXml({
          tenantNif,
          invoiceNumber,
          issueDate,
          huettaAnterior: previousHash,
        });
        const signed = await this.verifactu.signWithTenantCert(invoiceId, xml);
        await this.prisma.invoice.update({
          where: { id: invoiceId },
          data: { fiscalXml: signed.signedXml, fiscalStatus: "pending" },
        });
        const result = await this.verifactu.dispatch({
          invoiceId,
          xml: signed.signedXml,
          tenantNif,
          nif: invoice.recipientTaxId ?? "",
          invoiceNumber,
          issueDate,
          totalCents: invoice.totalCents,
        });
        await this.handleDispatchResult(invoice, result, _reason);
        return result.status !== "error";
      }

      if (mode === FiscalMode.ticketbai) {
        const settingsProv = settings as Record<string, unknown>;
        const diputacion =
          (settingsProv.diputacion as "bizkaia" | "gipuzkoa" | "alava") ?? "bizkaia";
        xml = this.ticketBai.buildAnulateXml({
          tenantNif,
          invoiceNumber,
          issueDate,
          huettaAnterior: previousHash,
        });
        const signed = await this.verifactu.signWithTenantCert(invoiceId, xml);
        await this.prisma.invoice.update({
          where: { id: invoiceId },
          data: { fiscalXml: signed.signedXml, fiscalStatus: "pending" },
        });
        const result = await this.ticketBai.dispatch({
          invoiceId,
          xml: signed.signedXml,
          invoiceNumber,
          issueDate,
          totalCents: invoice.totalCents,
          tenantNif,
          recipientNif: invoice.recipientTaxId ?? undefined,
          diputacion,
        });
        // Reuse the same post-processing as Verifactu — match the
        // 'pending for retry vs permanent' contract.
        if (result.status === "accepted") {
          await this.prisma.invoice.update({
            where: { id: invoiceId },
            data: {
              fiscalStatus: "accepted",
              fiscalReference: result.tbaiCode ?? null,
              fiscalQrUrl: (result as any).qrUrl ?? null,
              fiscalError: null,
            },
          });
          return true;
        }
        if (result.status === "rejected") {
          await this.prisma.invoice.update({
            where: { id: invoiceId },
            data: {
              fiscalStatus: "rejected",
              fiscalReference: result.tbaiCode ?? null,
              fiscalError: result.error ?? null,
            },
          });
          return true;
        }
        // result.status === 'error'
        if (this.isRetryableError(result.error)) {
          await this.enqueueRetry(invoice, result.error);
          return false;
        }
        await this.prisma.invoice.update({
          where: { id: invoiceId },
          data: {
            fiscalStatus: "error",
            fiscalError: result.error ?? null,
          },
        });
        return false;
      }
    } catch (err) {
      this.logger.warn(
        `anulateInvoice failed for ${invoiceId}: ${(err as Error).message}`,
      );
      // Mark the invoice with the cert-related error so the owner can
      // debug. Without this the invoice stays in `pending` forever.
      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          fiscalStatus: "error",
          fiscalError: (err as Error).message,
        },
      });
      return false;
    }
    return false;
  }

  /**
   * Apply the dispatch result to the Invoice row + decide whether to
   * enqueue a retry. Shared by both Verifactu emission flows and
   * TicketBAI anulación to keep the post-processing logic in sync.
   *
   * Status semantics — match the existing dispatchVerifactu contract:
   *   - "accepted"  →  fiscalStatus=accepted (invoice stays registered)
   *   - "rejected"  →  fiscalStatus=rejected (permanent error, no retry)
   *   - "error"     →  retryable? status stays 'pending' + retry queued
   *                    : non-retryable? status=error (permanent)
   */
  private async handleDispatchResult(
    invoice: any,
    result: { status: "accepted" | "rejected" | "error"; reference?: string; error?: string; qrUrl?: string },
    _reason: string,
  ): Promise<void> {
    if (result.status === "accepted") {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          fiscalStatus: "accepted",
          fiscalReference: result.reference ?? null,
          fiscalError: null,
          fiscalQrUrl: result.qrUrl ?? null,
        },
      });
      return;
    }
    if (result.status === "rejected") {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          fiscalStatus: "rejected",
          fiscalReference: result.reference ?? null,
          fiscalError: result.error ?? null,
        },
      });
      return;
    }
    // result.status === 'error'
    if (this.isRetryableError(result.error)) {
      // Stay 'pending' for retry — don't lose the queue state.
      await this.enqueueRetry(invoice, result.error);
      return;
    }
    // Permanent error (4xx that wasn't tagged 'rejected').
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        fiscalStatus: "error",
        fiscalError: result.error ?? null,
      },
    });
  }

  private async dispatchVerifactu(invoice: any) {
    const settings = (invoice.tenant.fiscalSettings as Record<string, unknown>) ?? {};
    const tenantNif = (settings.tenantNif as string) ?? invoice.issuerTaxIdAtIssue ?? "";
    const chain = await this.prisma.fiscalChainState.findUnique({
      where: {
        tenantId_fiscalMode: {
          tenantId: invoice.tenantId,
          fiscalMode: FiscalMode.verifactu,
        },
      },
    });
    const previousHash = chain?.lastHash ?? null;
    const issueDate = invoice.issueDate.toISOString().slice(0, 10);
    const invoiceNumber = `${invoice.series}${invoice.number}`;
    const taxBreakdown = (invoice.taxBreakdown as Array<{ taxCents: number }>) ?? [];
    const totalTaxCents = taxBreakdown.reduce((s, t) => s + t.taxCents, 0);

    const huella = buildVerifactuHuella({
      tenantNif,
      invoiceNumber,
      issueDate,
      totalTaxCents,
      totalCents: invoice.totalCents,
      previousHash,
    });

    const xml = this.verifactu.buildInvoiceXml({
      invoiceId: invoice.id,
      tenantNif,
      nif: invoice.recipientTaxId ?? "",
      invoiceNumber,
      issueDate,
      totalCents: invoice.totalCents,
      subtotalCents: invoice.subtotalCents,
      taxBreakdown: (invoice.taxBreakdown as any[]) ?? [],
      huettaAnterior: previousHash,
    });

    const result = await this.verifactu.dispatch({
      invoiceId: invoice.id,
      xml,
      tenantNif,
      nif: invoice.recipientTaxId ?? "",
      invoiceNumber,
      issueDate,
      totalCents: invoice.totalCents,
    });

    if (result.status === "accepted") {
      await this.prisma.fiscalChainState.upsert({
        where: {
          tenantId_fiscalMode: {
            tenantId: invoice.tenantId,
            fiscalMode: FiscalMode.verifactu,
          },
        },
        create: {
          tenantId: invoice.tenantId,
          fiscalMode: FiscalMode.verifactu,
          lastHash: huella,
          lastNumber: invoiceNumber,
          lastSubmittedAt: new Date(),
        },
        update: {
          lastHash: huella,
          lastNumber: invoiceNumber,
          lastSubmittedAt: new Date(),
        },
      });
      return;
    }

    if (this.isRetryableError(result.error)) {
      await this.enqueueRetry(invoice, result.error);
    }
  }

  private async dispatchTicketBai(invoice: any) {
    const settings = (invoice.tenant.fiscalSettings as Record<string, unknown>) ?? {};
    const tenantNif = (settings.tenantNif as string) ?? invoice.issuerTaxIdAtIssue ?? "";
    const chain = await this.prisma.fiscalChainState.findUnique({
      where: {
        tenantId_fiscalMode: {
          tenantId: invoice.tenantId,
          fiscalMode: FiscalMode.ticketbai,
        },
      },
    });
    const previousHash = chain?.lastHash ?? null;
    const issueDate = invoice.issueDate.toISOString().slice(0, 10);
    const invoiceNumber = `${invoice.series}${invoice.number}`;
    const taxBreakdown = (invoice.taxBreakdown as Array<{ taxCents: number }>) ?? [];
    const totalTaxCents = taxBreakdown.reduce((s, t) => s + t.taxCents, 0);

    const huella = buildTicketBaiHuella({
      tenantNif,
      invoiceNumber,
      issueDate,
      totalTaxCents,
      totalCents: invoice.totalCents,
      previousHash,
    });

    const xml = this.ticketBai.buildTbaiXml({
      invoiceNumber,
      issueDate,
      totalCents: invoice.totalCents,
      tenantNif,
      recipientNif: invoice.recipientTaxId ?? undefined,
      breakdown: (invoice.taxBreakdown as any[]) ?? [],
      huettaAnterior: previousHash,
    });

    const diputacion =
      (settings.diputacion as "bizkaia" | "gipuzkoa" | "alava") ?? "bizkaia";

    const result = await this.ticketBai.dispatch({
      invoiceId: invoice.id,
      xml,
      invoiceNumber,
      issueDate,
      totalCents: invoice.totalCents,
      tenantNif,
      recipientNif: invoice.recipientTaxId ?? undefined,
      diputacion,
    });

    if (result.status === "accepted") {
      await this.prisma.fiscalChainState.upsert({
        where: {
          tenantId_fiscalMode: {
            tenantId: invoice.tenantId,
            fiscalMode: FiscalMode.ticketbai,
          },
        },
        create: {
          tenantId: invoice.tenantId,
          fiscalMode: FiscalMode.ticketbai,
          lastHash: huella,
          lastNumber: invoiceNumber,
          lastSubmittedAt: new Date(),
        },
        update: {
          lastHash: huella,
          lastNumber: invoiceNumber,
          lastSubmittedAt: new Date(),
        },
      });
      return;
    }

    if (this.isRetryableError(result.error)) {
      await this.enqueueRetry(invoice, result.error);
    }
  }

  private async dispatchSii(invoice: any) {
    const settings = (invoice.tenant.fiscalSettings as Record<string, unknown>) ?? {};
    const tenantNif = (settings.tenantNif as string) ?? invoice.issuerTaxIdAtIssue ?? "";
    await this.sii.submit({
      invoiceId: invoice.id,
      tenantNif,
      invoiceNumber: `${invoice.series}${invoice.number}`,
      issueDate: invoice.issueDate.toISOString().slice(0, 10),
      totalCents: invoice.totalCents,
      taxBreakdown: (invoice.taxBreakdown as any[]) ?? [],
    });
  }

  /**
   * Returns true when the dispatch error pattern includes an HTTP code
   * in the 5xx range or "AEAT 503" / "ECONNRESET" style markers â€”
   * i.e. transient failures that the retry queue should re-attempt.
   */
  private isRetryableError(errorMsg?: string): boolean {
    if (!errorMsg) return false;
    const aeatMatch = errorMsg.match(/AEAT[^\d]*5\d\d|gipuzkoa[^\d]*5\d\d|alava[^\d]*5\d\d|bizkaia[^\d]*5\d\d/i);
    if (aeatMatch) {
      return true;
    }
    if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(errorMsg)) {
      return true;
    }
    return false;
  }

  /**
   * Schedule a retry via the in-process FiscalRetryQueue. Persists the
   * invoice status as "pending" so the dashboard reflects the
   * in-flight retry.
   */
  private async enqueueRetry(invoice: any, lastError?: string): Promise<void> {
    if (!this.retryQueue) return; // module not wired â€” no-op
    await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: { fiscalStatus: "pending", fiscalError: lastError },
    });
    await this.retryQueue.schedule(
      invoice.id,
      0,
      FiscalRetryDelayForAttempt(0),
      lastError,
    );
  }
}

function FiscalRetryDelayForAttempt(attempt: number): number {
  const ms = [5 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000];
  return ms[attempt] ?? ms[ms.length - 1];
}
