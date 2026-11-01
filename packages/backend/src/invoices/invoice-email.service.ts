import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InvoiceStatus, UserRole } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { isPlaceholderEmail } from "../common/placeholder-email";
import { EmailService } from "../notifications/services/email.service";
import { AuditLogService } from "../saas/audit-log.service";
import { InvoiceRenderService } from "./pdf/invoice-render.service";

export interface InvoiceEmailActor {
  id: string;
  role: UserRole;
  impersonatedBy?: string;
}

/**
 * "Enviar por email" on the invoices screen (POST /invoices/:id/email): the
 * invoice's PDF, attached, to the client's email or to the address the salon
 * typed. Who sent it, and where, is kept in the audit log.
 */
@Injectable()
export class InvoiceEmailService {
  private readonly logger = new Logger(InvoiceEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly render: InvoiceRenderService,
    private readonly email: EmailService,
    private readonly auditLog: AuditLogService,
  ) {}

  async send(
    tenantId: string,
    invoiceId: string,
    actor: InvoiceEmailActor,
    to?: string | null,
  ): Promise<{ sent: true; to: string }> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: { id: true, status: true, recipientId: true, recipientType: true },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status === InvoiceStatus.cancelled) {
      throw new BadRequestException("La factura está anulada: no se puede enviar");
    }

    const typed = to?.trim() || null;
    const address = typed ?? (await this.clientEmail(tenantId, invoice));
    if (!address) {
      throw new BadRequestException("La clienta no tiene email: escribe la dirección a la que enviarla");
    }
    if (!this.email.isConfigured()) {
      throw new ServiceUnavailableException("El envío de emails no está configurado");
    }

    const { pdf, filename, doc, input } = await this.render.render(tenantId, invoiceId);
    const result = await this.email.sendInvoice({
      to: address,
      recipientName: doc.recipient.name,
      salonName: input.tenant.name,
      salonEmail: input.tenant.email,
      title: doc.title,
      number: doc.fullNumber,
      issueDate: doc.issueDate,
      total: doc.totals.total,
      pdf,
      filename,
    });
    if (!result.success) {
      this.logger.warn(`Invoice ${doc.fullNumber} (${invoiceId}) not emailed: ${result.error}`);
      throw new BadGatewayException("No se pudo enviar el email. Inténtalo de nuevo en unos minutos.");
    }

    this.logger.log(`Invoice ${doc.fullNumber} (${invoiceId}) emailed by user ${actor.id}`);
    try {
      await this.auditLog.record("invoice.emailed", {
        actorId: actor.id,
        actorRole: actor.role,
        tenantId,
        metadata: {
          invoiceId,
          number: doc.fullNumber,
          to: address,
          toClientEmail: !typed,
          emailId: result.id ?? null,
          ...(actor.impersonatedBy ? { impersonatedBy: actor.impersonatedBy } : {}),
        },
      });
    } catch (err) {
      // Sent is sent: a failed audit write is logged, not reported as a failed send.
      this.logger.warn(`Audit log for invoice email ${invoiceId} failed: ${(err as Error).message}`);
    }
    return { sent: true, to: address };
  }

  private async clientEmail(
    tenantId: string,
    invoice: { recipientId: string | null; recipientType: string },
  ): Promise<string | null> {
    if (!invoice.recipientId || invoice.recipientType !== "client") return null;
    const client = await this.prisma.client.findFirst({
      where: { id: invoice.recipientId, tenantId },
      select: { email: true },
    });
    const email = client?.email?.trim();
    return email && !isPlaceholderEmail(email) ? email : null;
  }
}
