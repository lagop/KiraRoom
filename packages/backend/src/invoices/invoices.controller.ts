import {
  BadRequestException,
  ConflictException,
  Body,
  HttpException,
  Controller,
  Get,
  Header,
  Logger,
  Optional,
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
import { verifactuAvailable } from "./fiscal/verifactu/config";
import { nif as normaliseNif } from "./fiscal/verifactu/format";
import { NS } from "./fiscal/verifactu/xml";
import { installationNumberFor } from "./fiscal/verifactu/verifactu-records.service";
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
import { RESERVED_SERIES, salonDay } from "./invoice-numbering";
import { FISCAL_SETTINGS_SELECT, fiscalSettingsView, issuerIdentityPatch, normalizeSeries } from "./fiscal-identity";
import { AuditLogService } from "../saas/audit-log.service";
import { PlatformStripeConfigService } from "../platform/platform-stripe-config.service";
import { livemodeOf, sameStripeMode } from "../platform/stripe-settings";
import { BILLING_IDENTITY_SELECT, syncBillingCustomer } from "../payments/billing-customer";
import { taxLabelOf, taxRegimeOf, TAX_REGIME_DEFAULT_RATE } from "@kira/shared";
import { territoryTaxRegime } from "./salon-tax-settings";
import { NotDuringSupport } from "../common/decorators/not-during-support.decorator";

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
    @Optional() private readonly auditLog?: AuditLogService,
    @Optional() private readonly platformStripe?: PlatformStripeConfigService,
  ) {}

  private readonly logger = new Logger(InvoicesController.name);

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

  /**
   * Whether the salon has the issuer data every invoice needs (NIF, razón
   * social, fiscal address), for the panel's warning; and from when invoices
   * without it are refused (INVOICE_ISSUER_BLOCK_FROM). Before ":id".
   */
  @Get("issuer-status")
  @Roles(...SALON_MANAGERS)
  issuerStatus(@Req() req: AuthedRequest) {
    return this.invoices.issuerStatus(this.requireTenantId(req));
  }

  @Get(":id")
  @Roles(...SALON_MANAGERS)
  findOne(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.invoices.findOne(this.requireTenantId(req), id);
  }

  @Post()
  @Roles(UserRole.owner, UserRole.admin)
  create(@Req() req: AuthedRequest, @Body() dto: CreateInvoiceDto) {
    return this.invoices.createManual({
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

  // POST /invoices/from-order/:orderId is gone: nothing called it, it issued
  // a new invoice on every call and any staff member could use it. The till
  // issues its simplified invoices from inside the sale
  // (InvoiceService.issueSimplifiedInvoiceForSale).

  /**
   * Invoices a completed appointment of this salon now, whatever the
   * automatic-invoicing setting: the way to invoice it again after its
   * invoice was cancelled. Its live invoice when it has one.
   */
  @Post("from-appointment/:appointmentId")
  @Roles(UserRole.owner, UserRole.admin)
  fromAppointment(
    @Req() req: AuthedRequest,
    @Param("appointmentId", ParseUUIDPipe) appointmentId: string,
  ) {
    return this.invoices.fromAppointment(appointmentId, {
      tenantId: this.requireTenantId(req),
      requested: true,
    });
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
    const record = await this.prisma.verifactuRecord.findFirst({ where: { invoiceId: id }, orderBy: { sequence: "desc" } });
    if (record) {
      res.setHeader("Content-Disposition", `attachment; filename="verifactu-${invoice.series}${invoice.number}.xml"`);
      // The record as sent, as a document of its own.
      return res.send(
        `<?xml version="1.0" encoding="UTF-8"?>` + record.xml.replace(/^<sum1:(\w+)>/, `<sum1:$1 xmlns:sum1="${NS.sum1}">`),
      );
    }
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
      select: {
        ...FISCAL_SETTINGS_SELECT,
        // For territoryTaxRegime below, never sent.
        street: true,
        city: true,
        state: true,
        postalCode: true,
        country: true,
        timezone: true,
      },
    });
    // The regime the salon's address calls for (IGIC in the Canaries, IPSI
    // in Ceuta and Melilla) when it is on another one: the panel shows a
    // notice, as the switch is only automatic before the first invoice
    // (audit 7 N6). Null otherwise.
    const territory = tenant ? territoryTaxRegime(tenant, tenant.timezone) : null;
    const territoryRegime = territory && taxRegimeOf(tenant?.fiscalSettings) !== territory ? territory : null;
    // The NIF, its type and the razón social go too: the page loads its form
    // from this, and without them it saved them back empty.
    // submissionAvailable: the page says that nothing is sent to the AEAT yet.
    return {
      ...fiscalSettingsView(tenant),
      submissionAvailable: fiscalSubmissionAvailable(),
      territoryTaxRegime: territoryRegime,
    };
  }

  @NotDuringSupport()
  @Patch("settings/fiscal")
  @Roles(UserRole.owner)
  async updateFiscalSettings(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateTenantFiscalSettingsDto,
  ) {
    const tenantId = this.requireTenantId(req);
    // An empty razón social or NIF is refused, never stored over the real
    // one; a NIF that does not validate is refused too (fiscal-identity.ts).
    const identity = issuerIdentityPatch(dto);
    // "a" and "A" were two numbering sequences, and "" invoices with no series.
    const defaultSeries = dto.defaultSeries !== undefined ? normalizeSeries(dto.defaultSeries) : undefined;
    if (defaultSeries !== undefined && RESERVED_SERIES.includes(defaultSeries)) {
      throw new BadRequestException(
        `La serie "${defaultSeries}" está reservada: R es la de las rectificativas y T la de los tickets. Usa otra serie.`,
      );
    }
    const current = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { fiscalSettings: true, fiscalMode: true, taxId: true, timezone: true },
    });
    await this.checkFiscalModeChange(tenantId, current, dto, identity.taxId);
    const taxIdBefore = current?.taxId ?? null;
    const merged = {
      ...((current?.fiscalSettings as Record<string, unknown>) ?? {}),
      ...(defaultSeries !== undefined ? { defaultSeries } : {}),
      ...(dto.defaultTaxRate !== undefined ? { defaultTaxRate: dto.defaultTaxRate } : {}),
      ...(dto.autoInvoiceAppointments !== undefined
        ? { autoInvoiceAppointments: dto.autoInvoiceAppointments }
        : {}),
      ...(dto.diputacion !== undefined ? { diputacion: dto.diputacion } : {}),
      ...(identity.taxId !== undefined ? { tenantNif: identity.taxId } : {}),
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

    // fiscalSettings.tenantNif feeds the VERI*FACTU / TicketBAI blocks; the
    // Tenant columns are what invoices copy and the page shows. Both get the
    // same NIF. Fields that were not sent are left as they are.
    const updated = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        fiscalMode: dto.fiscalMode as FiscalMode | undefined,
        fiscalSettings: merged as any,
        ...identity,
      },
      select: FISCAL_SETTINGS_SELECT,
    });
    if (identity.taxId !== undefined && identity.taxId !== taxIdBefore) {
      await this.auditTaxIdChange(req, tenantId, taxIdBefore, identity.taxId);
    }
    if (dto.fiscalMode && dto.fiscalMode !== current?.fiscalMode) {
      await this.auditFiscalModeChange(req, tenantId, current?.fiscalMode ?? null, dto.fiscalMode);
    }
    if (Object.keys(identity).length > 0) {
      // Not awaited: Stripe's answer must not slow the save, and it never fails it.
      void this.syncStripeBillingIdentity(tenantId);
    }
    return { ...fiscalSettingsView(updated), submissionAvailable: fiscalSubmissionAvailable() };
  }

  /**
   * KiraRoom bills the salon as its Stripe customer: a new razón social or
   * NIF goes there too, so the next Stripe invoice to the salon carries
   * them (B1). Best effort, and only for a salon that has a customer.
   */
  private async syncStripeBillingIdentity(tenantId: string): Promise<void> {
    try {
      const stripe = this.platformStripe?.client();
      if (!stripe) return;
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { ...BILLING_IDENTITY_SELECT, stripeCustomerId: true, stripeCustomerLivemode: true },
      });
      if (!tenant?.stripeCustomerId) return;
      // A customer of the other Stripe mode does not exist for these keys.
      if (!sameStripeMode(tenant.stripeCustomerLivemode, livemodeOf(this.platformStripe?.mode?.() ?? "none"))) return;
      await syncBillingCustomer(stripe, tenant.stripeCustomerId, tenant, this.logger);
    } catch (err) {
      this.logger.warn(`Stripe billing identity of tenant ${tenantId} not updated: ${(err as Error).message}`);
    }
  }

  /**
   * The issuer NIF goes on every invoice, so who changed it and when is
   * kept, as the SaaS admin's edit does (tenant.taxId.change). A failed
   * audit write is logged: the change itself is already saved.
   */
  private async auditTaxIdChange(req: AuthedRequest, tenantId: string, before: string | null, after: string) {
    const user = req.user;
    if (!this.auditLog || !user?.id || !user.role) return;
    try {
      await this.auditLog.record("tenant.taxId.change", {
        actorId: user.id,
        actorRole: user.role,
        tenantId,
        metadata: {
          before,
          after,
          source: "settings/fiscal",
          ...(user.impersonatedBy ? { impersonatedBy: user.impersonatedBy } : {}),
        },
      });
    } catch (err) {
      this.logger.warn(`Audit log for the NIF change of tenant ${tenantId} failed: ${(err as Error).message}`);
    }
  }

  /** Switching VERI*FACTU on binds the salon until 31 December: who and when is kept. */
  private async auditFiscalModeChange(req: AuthedRequest, tenantId: string, before: string | null, after: string) {
    const user = req.user;
    if (!this.auditLog || !user?.id || !user.role) return;
    try {
      await this.auditLog.record("tenant.fiscalMode.change", {
        actorId: user.id,
        actorRole: user.role,
        tenantId,
        metadata: { before, after, ...(user.impersonatedBy ? { impersonatedBy: user.impersonatedBy } : {}) },
      });
    } catch (err) {
      this.logger.warn(`Audit log for the fiscal mode of tenant ${tenantId} failed: ${(err as Error).message}`);
    }
  }

  /**
   * VERI*FACTU: switching it on needs the salon's NIF and a certificate to
   * submit with; once on, it stays on until 31 December of the year
   * (Orden HAC/1177/2024 art. 17.2). TicketBAI and SII are not available.
   */
  private async checkFiscalModeChange(
    tenantId: string,
    current: { fiscalMode: FiscalMode; taxId: string | null; timezone: string } | null,
    dto: UpdateTenantFiscalSettingsDto,
    newTaxId: string | undefined,
  ) {
    const target = dto.fiscalMode as FiscalMode | undefined;
    if (!target || target === current?.fiscalMode) return;

    if (current?.fiscalMode === FiscalMode.verifactu) {
      const thisYear = salonDay(new Date(), current.timezone).slice(0, 4);
      const records = await this.prisma.verifactuRecord.count({
        where: { tenantId, fecha: { endsWith: `-${thisYear}` } },
      });
      if (records > 0) {
        throw new ConflictException(
          `Verifactu se mantiene activado hasta el 31 de diciembre de ${thisYear}: una vez que un sistema ha funcionado como VERI*FACTU, debe seguir así todo el año.`,
        );
      }
    }

    if (target === FiscalMode.verifactu) {
      if (!verifactuAvailable()) throw new ConflictException(FISCAL_SUBMISSION_UNAVAILABLE);
      if (!normaliseNif(newTaxId ?? current?.taxId)) {
        throw new BadRequestException("Para activar Verifactu, indica el NIF del salón.");
      }
      const hasCertificate =
        !!process.env.VERIFACTU_PLATFORM_P12 ||
        (await this.prisma.fiscalCertificate.count({ where: { tenantId, isActive: true, notAfter: { gt: new Date() } } })) > 0;
      if (!hasCertificate) {
        throw new BadRequestException(
          "Para activar Verifactu, sube primero el certificado electrónico con el que se enviarán las facturas a la AEAT.",
        );
      }
      await this.prisma.verifactuChain.upsert({
        where: { tenantId },
        create: { tenantId, installationNumber: installationNumberFor(tenantId) },
        update: {},
      });
      return;
    }

    // TicketBAI and SII are still stubs that answer "accepted": the flag that
    // opens VERI*FACTU in production must not open them with it.
    if (target !== FiscalMode.none && (process.env.NODE_ENV === "production" || !fiscalSubmissionAvailable())) {
      throw new ConflictException(FISCAL_SUBMISSION_UNAVAILABLE);
    }
  }

  // ---- Certificates ----

  @NotDuringSupport()
  @Post("certificates")
  @Roles(UserRole.owner)
  async uploadCertificate(
    @Req() req: AuthedRequest,
    @Body() body: UploadCertificateDto,
  ) {
    try {
      return await this.certs.saveCertificate({
        tenantId: this.requireTenantId(req),
        alias: body.alias,
        provider: body.provider,
        pkcs12Base64: body.pkcs12Base64,
        passphrase: body.passphrase,
        certificateType: body.certificateType,
      });
    } catch (err) {
      // What openPkcs12 refuses says why (wrong password, expired, no key).
      if (err instanceof HttpException) throw err;
      // A file that is not a PKCS#12 bundle answered a bare 500.
      this.logger.warn(`Certificate upload refused: ${(err as Error).message}`);
      throw new BadRequestException(
        "No se pudo leer el certificado. Sube el archivo .p12 o .pfx que te dio la FNMT (o tu proveedor) y comprueba la contraseña.",
      );
    }
  }

  @NotDuringSupport()
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

