import { Module, OnModuleInit, Injectable } from "@nestjs/common";
import { PrismaModule } from "../common/prisma/prisma.module";
import { AccountingModule } from "../accounting/accounting.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { InvoicesController } from "./invoices.controller";
import { InvoiceService } from "./invoices.service";
import { InvoiceCalculator } from "./invoice-calculator.service";
import { InvoicePdfService } from "./pdf/invoice-pdf.service";
import { FiscalService } from "./fiscal/fiscal.service";
import { FiscalCertificateService } from "./fiscal/fiscal-certificate.service";
import { FiscalRetryQueue } from "./fiscal/fiscal-retry.queue";
import { VerifactuService } from "./fiscal/verifactu.service";
import { TicketBaiService } from "./fiscal/ticketbai.service";
import { SiiService } from "./fiscal/sii.service";
import { XadesService } from "./fiscal/xades.service";
import { QrService } from "./fiscal/qr.service";
import { TaxReportsModule } from "./tax-reports/tax-reports.module";

/**
 * Bind the dispatch callback the retry queue needs on module init.
 * Without this binding, a transient AEAT 5xx would NOT retry — the queue
 * would log "skip" and the invoice would stay in `pending` forever.
 */
@Injectable()
class InvoicesModuleInit implements OnModuleInit {
  constructor(
    private readonly queue: FiscalRetryQueue,
    private readonly fiscalService: FiscalService,
  ) {}
  onModuleInit(): void {
    this.queue.bindDispatchFn(async (invoiceId) => {
      await this.fiscalService.dispatchInvoice(invoiceId);
      const inv = await this.fiscalService["prisma"].invoice.findUnique({
        where: { id: invoiceId },
        select: { fiscalStatus: true, fiscalError: true },
      });
      if (!inv) return { status: "skipped", error: "missing" };
      return {
        status: inv.fiscalStatus === "accepted"
          ? "accepted"
          : inv.fiscalStatus === "rejected"
          ? "rejected"
          : inv.fiscalStatus === "error"
          ? "error"
          : "needs_refresh",
        error: inv.fiscalError ?? undefined,
      };
    });
  }
}

@Module({
  imports: [PrismaModule, AccountingModule, NotificationsModule, TaxReportsModule],
  controllers: [InvoicesController],
  providers: [
    InvoiceService,
    InvoiceCalculator,
    InvoicePdfService,
    FiscalService,
    FiscalCertificateService,
    FiscalRetryQueue,
    VerifactuService,
    TicketBaiService,
    SiiService,
    XadesService,
    QrService,
    InvoicesModuleInit,
  ],
  exports: [
    InvoiceService,
    FiscalService,
    FiscalCertificateService,
    FiscalRetryQueue,
  ],
})
export class InvoicesModule {}
