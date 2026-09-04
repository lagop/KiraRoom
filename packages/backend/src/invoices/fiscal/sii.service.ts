import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";

export interface SiiSubmissionInput {
  invoiceId: string;
  tenantNif: string;
  invoiceNumber: string;
  issueDate: string;
  totalCents: number;
  taxBreakdown: Array<{ rate: number; baseCents: number; taxCents: number }>;
}

export interface SiiSubmissionResult {
  status: "accepted" | "rejected" | "error";
  csv?: string;
  error?: string;
}

/**
 * Suministro Inmediato de Información (SII) — IVA reporting.
 *
 * SII does not "approve" individual invoices in real-time. It accepts
 * submissions and returns a CSV receipt that the tenant must keep for audit.
 * The bookkeeping model (SuministroLRFacturasEmitidas) is sent per period
 * (typically daily for high-volume operations).
 *
 * This service is a STUB. Production must:
 *   - SOAP client with WSSecurity headers (cert-based auth)
 *   - Endpoint: https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/ssii/...
 */
@Injectable()
export class SiiService {
  private readonly logger = new Logger(SiiService.name);

  constructor(private readonly prisma: PrismaService) {}

  async submit(input: SiiSubmissionInput): Promise<SiiSubmissionResult> {
    try {
      const result = await this._postSoap(input);
      await this.prisma.invoice.update({
        where: { id: input.invoiceId },
        data: {
          fiscalStatus: result.status === "accepted" ? "accepted" : "rejected",
          fiscalReference: result.csv,
          fiscalError: result.error,
          fiscalSubmittedAt: new Date(),
        },
      });
      return result;
    } catch (err) {
      this.logger.warn(
        `SII submission failed for invoice ${input.invoiceId}: ${(err as Error).message}`,
      );
      await this.prisma.invoice.update({
        where: { id: input.invoiceId },
        data: {
          fiscalStatus: "error",
          fiscalError: (err as Error).message,
          fiscalSubmittedAt: new Date(),
        },
      });
      return { status: "error", error: (err as Error).message };
    }
  }

  private async _postSoap(
    _input: SiiSubmissionInput,
  ): Promise<{ status: "accepted" | "rejected"; csv?: string; error?: string }> {
    return { status: "accepted", csv: "SII-STUB-" + Date.now() };
  }
}