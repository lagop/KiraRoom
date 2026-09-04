import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UserRole, InvoiceSource, FiscalMode } from "@prisma/client";
import { InvoiceService } from "./invoices.service";
import { InvoicePdfService } from "./pdf/invoice-pdf.service";
import { FiscalCertificateService } from "./fiscal/fiscal-certificate.service";
import {
  CancelInvoiceDto,
  CreateInvoiceDto,
  ListInvoicesQueryDto,
  UpdateTenantFiscalSettingsDto,
} from "./dto/invoice.dto";
import { PrismaService } from "../common/prisma/prisma.service";

interface AuthedRequest extends Request {
  user: { tenantId?: string };
}

@Controller("invoices")
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvoicesController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly pdf: InvoicePdfService,
    private readonly certs: FiscalCertificateService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  list(@Req() req: AuthedRequest, @Query() q: ListInvoicesQueryDto) {
    return this.invoices.list(this.requireTenantId(req), q);
  }

  @Get(":id")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  findOne(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.invoices.findOne(this.requireTenantId(req), id);
  }

  @Post()
  @Roles(UserRole.owner, UserRole.admin)
  create(@Req() req: AuthedRequest, @Body() dto: CreateInvoiceDto) {
    return this.invoices.create({
      ...dto,
      tenantId: this.requireTenantId(req),
      issueDate: dto.issueDate ? new Date(dto.issueDate) : undefined,
      lines: dto.lines.map((l) => ({
        ...l,
        discountPct: l.discountPct ?? 0,
      })),
    });
  }

  @Post(":id/cancel")
  @Roles(UserRole.owner, UserRole.admin)
  cancel(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CancelInvoiceDto,
  ) {
    return this.invoices.cancel(this.requireTenantId(req), id, dto.reason);
  }

  @Post(":id/anulate")
  @Roles(UserRole.owner, UserRole.admin)
  anulate(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CancelInvoiceDto,
  ) {
    return this.invoices.anulate(this.requireTenantId(req), id, dto.reason);
  }

  @Post(":id/rectify")
  @Roles(UserRole.owner, UserRole.admin)
  rectify(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body()
    body: {
      reason: string;
      lines: Array<{
        description: string;
        quantity: number;
        unitPriceCents: number;
        taxRate: number;
      }>;
    },
  ) {
    return this.invoices.emitRectification(
      this.requireTenantId(req),
      id,
      body.lines,
      body.reason,
    );
  }

  @Post(":id/resend-fiscal")
  @Roles(UserRole.owner)
  resend(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.invoices.resendFiscal(this.requireTenantId(req), id);
  }

  @Post("from-order/:orderId")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  fromOrder(@Req() req: AuthedRequest, @Param("orderId") orderId: string) {
    void req;
    return this.invoices.fromOrder(orderId);
  }

  @Post("from-appointment/:appointmentId")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  fromAppointment(
    @Req() req: AuthedRequest,
    @Param("appointmentId") appointmentId: string,
  ) {
    void req;
    return this.invoices.fromAppointment(appointmentId);
  }

  @Get(":id/pdf")
  @Header("Content-Type", "application/pdf")
  async pdfStream(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const tenantId = this.requireTenantId(req);
    const invoice = await this.invoices.findOne(tenantId, id);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) throw new BadRequestException("Tenant not found");
    const lines = invoice.lines.map((l) => ({
      description: l.description,
      quantity: Number(l.quantity),
      unitPriceCents: l.unitPriceCents,
      discountPct: Number(l.discountPct),
      taxRate: Number(l.taxRate),
      totalCents: l.totalCents,
    }));
    const buf = await this.pdf.generate({
invoice: {
        series: invoice.series,
        number: invoice.number,
        issueDate: invoice.issueDate.toISOString(),
        recipientName: invoice.recipientName,
        recipientTaxId: invoice.recipientTaxId,
        recipientAddress: invoice.recipientAddress as any,
        subtotalCents: invoice.subtotalCents,
        totalCents: invoice.totalCents,
        currency: invoice.currency,
fiscalQrUrl: invoice.fiscalQrUrl,
        fiscalReference: invoice.fiscalReference,
      },
      lines,
      taxBreakdown: (invoice.taxBreakdown as any[]) ?? [],
      tenant: {
        name: tenant.name,
        taxId: null, // would come from Tenant settings
        address: null,
        email: tenant.email,
        phone: tenant.phone,
      },
    });
    res.setHeader("Content-Disposition", `inline; filename="invoice-${invoice.series}${invoice.number}.pdf"`);
    res.send(buf);
  }

  @Get(":id/xml")
  @Header("Content-Type", "application/xml")
  async xml(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const invoice = await this.invoices.findOne(this.requireTenantId(req), id);
    if (!invoice.fiscalXml) {
      throw new BadRequestException("Invoice has no fiscal XML yet");
    }
    res.setHeader(
      "Content-Disposition",
      `inline; filename="invoice-${invoice.series}${invoice.number}.xml"`,
    );
    res.send(invoice.fiscalXml);
  }

  // ---- Tenant fiscal settings ----

  @Get("settings/fiscal")
  @Roles(UserRole.owner, UserRole.admin)
  async getFiscalSettings(@Req() req: AuthedRequest) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: this.requireTenantId(req) },
      select: { fiscalMode: true, fiscalSettings: true },
    });
    return tenant;
  }

  @Patch("settings/fiscal")
  @Roles(UserRole.owner)
  async updateFiscalSettings(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateTenantFiscalSettingsDto,
  ) {
    const tenantId = this.requireTenantId(req);
    const current = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { fiscalSettings: true },
    });
    const merged = {
      ...((current?.fiscalSettings as Record<string, unknown>) ?? {}),
      ...(dto.defaultSeries !== undefined ? { defaultSeries: dto.defaultSeries } : {}),
      ...(dto.defaultTaxRate !== undefined ? { defaultTaxRate: dto.defaultTaxRate } : {}),
      ...(dto.autoInvoiceAppointments !== undefined
        ? { autoInvoiceAppointments: dto.autoInvoiceAppointments }
        : {}),
      ...(dto.diputacion !== undefined ? { diputacion: dto.diputacion } : {}),
      ...(dto.tenantNif !== undefined ? { tenantNif: dto.tenantNif } : {}),
    };

    // The fiscalSettings.tenantNif field feeds the AEAT Verifactu /
    // TicketBAI `<Verifactu>` block. We also mirror it (along with
    // taxIdType and legalName) to the new Tenant columns for the
    // dashboard + future analytics.
    const tenantNifInSettings = (merged as any).tenantNif;
    const taxIdUpdate = tenantNifInSettings
      ? { taxId: tenantNifInSettings }
      : {};
    const taxIdTypeUpdate =
      dto.taxIdType !== undefined ? { taxIdType: dto.taxIdType } : {};
    const legalNameUpdate =
      dto.legalName !== undefined ? { legalName: dto.legalName } : {};

    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        fiscalMode: dto.fiscalMode as FiscalMode | undefined,
        fiscalSettings: merged as any,
        ...taxIdUpdate,
        ...taxIdTypeUpdate,
        ...legalNameUpdate,
      },
      select: {
        fiscalMode: true,
        fiscalSettings: true,
        taxId: true,
        taxIdType: true,
        legalName: true,
      },
    });
  }

  // ---- Certificates ----

  @Get("certificates")
  @Roles(UserRole.owner)
  listCertificates(@Req() req: AuthedRequest) {
    return this.certs.listActiveCertificates(this.requireTenantId(req));
  }

  @Post("certificates")
  @Roles(UserRole.owner)
  async uploadCertificate(
    @Req() req: AuthedRequest,
    @Body()
    body: {
      alias: string;
      provider: "p12" | "cloud_dnie";
      pkcs12Base64: string;
      passphrase: string;
    },
  ) {
    return this.certs.saveCertificate({
      tenantId: this.requireTenantId(req),
      alias: body.alias,
      provider: body.provider,
      pkcs12Base64: body.pkcs12Base64,
      passphrase: body.passphrase,
    });
  }

  @Patch("certificates/:id/deactivate")
  @Roles(UserRole.owner)
  deactivateCertificate(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.certs.deactivate(id, this.requireTenantId(req));
  }

  private requireTenantId(req: AuthedRequest): string {
    const t = req.user?.tenantId;
    if (!t) throw new Error("Missing tenantId on authenticated request");
    return t;
  }

  // Suppress unused-imports lint warnings.
  private _u: InvoiceSource = InvoiceSource.manual;
}

