import {
  BadRequestException,
  ConflictException,
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
import { fiscalSubmissionAvailable, FISCAL_SUBMISSION_UNAVAILABLE } from "./fiscal/fiscal-availability";
import type { Response } from "express";
import { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UserRole, InvoiceSource, FiscalMode } from "@prisma/client";
import { InvoiceService } from "./invoices.service";
import { InvoiceRenderService } from "./pdf/invoice-render.service";
import { InvoiceEmailService } from "./invoice-email.service";
import { SendInvoiceEmailDto } from "./dto/send-invoice-email.dto";
import { Throttle } from "@nestjs/throttler";
import { FiscalCertificateService } from "./fiscal/fiscal-certificate.service";
import {
  CancelInvoiceDto,
  CreateInvoiceDto,
  ListInvoicesQueryDto,
  RectifyInvoiceDto,
  UpdateTenantFiscalSettingsDto,
  UploadCertificateDto,
} from "./dto/invoice.dto";
import { PrismaService } from "../common/prisma/prisma.service";
import { taxLabelOf, taxRegimeOf, TAX_REGIME_DEFAULT_RATE } from "@kira/shared";

interface AuthedRequest extends Request {
  user: { tenantId?: string; id?: string; role?: UserRole; impersonatedBy?: string };
}

@Controller("invoices")
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvoicesController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly render: InvoiceRenderService,
    private readonly certs: FiscalCertificateService,
    private readonly prisma: PrismaService,
    private readonly invoiceEmail: InvoiceEmailService,
  ) {}

  // Owner and admin only, like the rest of the invoice routes: invoices
  // carry the clients' NIFs and the salon's takings, which staff do not see.
  @Get()
  @Roles(...SALON_MANAGERS)
  list(@Req() req: AuthedRequest, @Query() q: ListInvoicesQueryDto) {
    return this.invoices.list(this.requireTenantId(req), q);
  }

  // Before ":id": declared after it, "certificates" matched ":id" first and
  // ParseUUIDPipe answered 400, so the fiscal certificates list never loaded.
  @Get("certificates")
  @Roles(UserRole.owner)
  listCertificates(@Req() req: AuthedRequest) {
    return this.certs.listActiveCertificates(this.requireTenantId(req));
  }

  @Get(":id")
  @Roles(...SALON_MANAGERS)
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
        // true or false as sent; left out, the salon's pricesIncludeTax.
        taxIncluded: typeof l.taxIncluded === "boolean" ? l.taxIncluded : undefined,
      })),
      // A line without taxIncluded used to get the tax on top whatever the
      // salon's setting: 30,00 EUR became 36,30 for a salon whose prices
      // include it. Now it follows Ajustes fiscales, server-side.
      taxIncludedFromSalon: true,
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
    @Body() body: RectifyInvoiceDto,
  ) {
    return this.invoices.emitRectification(
      this.requireTenantId(req),
      id,
      // Left out: the whole invoice. A line with originalLineId credits that
      // line of the original, from its stored amounts (rectification-lines.ts).
      body.lines?.map((l) => ({
        originalLineId: l.originalLineId,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        discountPct: l.discountPct,
        taxRate: l.taxRate,
        // Free lines: as sent; left out, the salon's pricesIncludeTax.
        taxIncluded: typeof l.taxIncluded === "boolean" ? l.taxIncluded : undefined,
      })),
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

  /**
   * The invoice's PDF: issuer with razón social, NIF and address (as they
   * were at issue when the invoice snapshotted them), recipient, lines, tax
   * breakdown and totals (InvoiceRenderService). The panel downloads it with
   * fetch and the bearer token: a plain link carried no token and got 401.
   */
  @Get(":id/pdf")
  @Roles(...SALON_MANAGERS)
  async pdfStream(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const { pdf, filename } = await this.render.render(this.requireTenantId(req), id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(pdf);
  }

  /** Sends the PDF to the client's email, or to `to`. Logged in the audit log. */
  @Post(":id/email")
  @Roles(...SALON_MANAGERS)
  @Throttle({ default: { ttl: 600_000, limit: 10 } }) // 10 emails per 10 min
  email(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SendInvoiceEmailDto,
  ) {
    const user = req.user;
    if (!user?.id || !user.role) throw new BadRequestException("Missing user on authenticated request");
    return this.invoiceEmail.send(
      this.requireTenantId(req),
      id,
      { id: user.id, role: user.role, impersonatedBy: user.impersonatedBy },
      dto.to,
    );
  }

  @Get(":id/xml")
  @Header("Content-Type", "application/xml")
  @Roles(...SALON_MANAGERS)
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
      `attachment; filename="factura-${invoice.series}${invoice.number}.xml"`,
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
    // The settings page uses this to say that nothing is sent to the AEAT yet.
    return { ...tenant, submissionAvailable: fiscalSubmissionAvailable() };
  }

  @Patch("settings/fiscal")
  @Roles(UserRole.owner)
  async updateFiscalSettings(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateTenantFiscalSettingsDto,
  ) {
    const tenantId = this.requireTenantId(req);
    if (dto.fiscalMode && dto.fiscalMode !== FiscalMode.none && !fiscalSubmissionAvailable()) {
      throw new ConflictException(FISCAL_SUBMISSION_UNAVAILABLE);
    }
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
      ...(dto.taxRegime !== undefined ? { taxRegime: dto.taxRegime } : {}),
      ...(typeof dto.pricesIncludeTax === "boolean" ? { pricesIncludeTax: dto.pricesIncludeTax } : {}),
    };

    // Switching regime without touching the rate would leave a Canarian salon
    // invoicing at 21 %, which no IGIC rate matches -- and the quarterly
    // report buckets by rate. So when the regime changes and the caller did
    // not also send a rate, move the default to that regime's usual one
    // (IVA 21, IGIC 7). An explicit defaultTaxRate in the same request always
    // wins: the operator may have a reason.
    if (
      dto.taxRegime !== undefined &&
      dto.defaultTaxRate === undefined &&
      dto.taxRegime !== taxRegimeOf(current?.fiscalSettings)
    ) {
      (merged as Record<string, unknown>).defaultTaxRate =
        TAX_REGIME_DEFAULT_RATE[dto.taxRegime];
    }

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

  @Post("certificates")
  @Roles(UserRole.owner)
  async uploadCertificate(
    @Req() req: AuthedRequest,
    @Body() body: UploadCertificateDto,
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

