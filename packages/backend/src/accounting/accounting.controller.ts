import { Body, Controller, Get, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { UserRole } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { AccountingService } from "./accounting.service";
import { InvoiceBookService } from "./invoice-book.service";
import {
  ConnectHoldedDto,
  InvoiceBookQueryDto,
  PushPendingDto,
  SyncInvoiceDto,
  UpdateAccountingSettingsDto,
} from "./dto/accounting.dto";

interface AuthedRequest extends Request {
  user: { tenantId?: string };
}

/**
 * Every route is scoped to the caller's tenant. The previous controller had
 * an OAuth callback for Holded/Sage (neither offers that flow to us: Holded
 * uses API keys) and a retry endpoint that drained every salon's queue.
 */
@ApiTags("accounting")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("accounting")
export class AccountingController {
  constructor(
    private readonly accounting: AccountingService,
    private readonly invoiceBook: InvoiceBookService,
  ) {}

  @Get("settings")
  @Roles(...SALON_MANAGERS)
  getSettings(@Req() req: AuthedRequest) {
    return this.accounting.status(this.requireTenantId(req));
  }

  @Patch("settings")
  @Roles(UserRole.owner)
  updateSettings(@Req() req: AuthedRequest, @Body() dto: UpdateAccountingSettingsDto) {
    return this.accounting.updateSettings(this.requireTenantId(req), dto);
  }

  @Post("holded/connect")
  @Roles(UserRole.owner)
  connectHolded(@Req() req: AuthedRequest, @Body() dto: ConnectHoldedDto) {
    return this.accounting.connectHolded(this.requireTenantId(req), dto.apiKey);
  }

  @Post("disconnect")
  @Roles(UserRole.owner)
  async disconnect(@Req() req: AuthedRequest) {
    await this.accounting.disconnect(this.requireTenantId(req));
    return { ok: true };
  }

  @Post("holded/push")
  @Roles(...SALON_MANAGERS)
  pushPending(@Req() req: AuthedRequest, @Body() dto: PushPendingDto) {
    return this.accounting.pushPending(this.requireTenantId(req), dto.from);
  }

  @Post("sync")
  @Roles(...SALON_MANAGERS)
  sync(@Req() req: AuthedRequest, @Body() dto: SyncInvoiceDto) {
    return this.accounting.syncInvoice(dto.invoiceId, {
      trigger: "manual",
      tenantId: this.requireTenantId(req),
    });
  }

  @Get("log")
  @Roles(...SALON_MANAGERS)
  log(@Req() req: AuthedRequest, @Query("limit") limit?: string) {
    const parsed = limit ? Math.min(parseInt(limit, 10) || 100, 200) : 100;
    return this.accounting.recentLogs(this.requireTenantId(req), parsed);
  }

  /** Libro de facturas emitidas for the gestoría (Sage, A3, NCS, any program). */
  @Get("export/facturas-emitidas")
  @Roles(...SALON_MANAGERS)
  async exportInvoiceBook(
    @Req() req: AuthedRequest,
    @Query() q: InvoiceBookQueryDto,
    @Res() res: Response,
  ) {
    const file = await this.invoiceBook.build(
      this.requireTenantId(req),
      q.from,
      q.to,
      q.format ?? "xlsx",
    );
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(file.body);
  }

  private requireTenantId(req: AuthedRequest): string {
    const t = req.user?.tenantId;
    if (!t) throw new Error("Missing tenantId on authenticated request");
    return t;
  }
}
