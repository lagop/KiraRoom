import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { Request } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UserRole } from "@prisma/client";
import { Public } from "../auth/decorators/public.decorator";
import { ClientCadenceService } from "./client-cadence.service";
import { RebookingDispatcherService } from "./rebooking-dispatcher.service";
import { UpdateRebookingConfigDto } from "./dto/rebooking.dto";
import { PrismaService } from "../common/prisma/prisma.service";
import { createHmac, timingSafeEqual } from "crypto";

interface AuthedRequest extends Request {
  user: { tenantId?: string };
}

@Controller("rebooking")
@UseGuards(JwtAuthGuard, RolesGuard)
export class RebookingController {
  constructor(
    private readonly cadence: ClientCadenceService,
    private readonly dispatcher: RebookingDispatcherService,
    private readonly prisma: PrismaService,
  ) {}

  @Get("config")
  @Roles(UserRole.owner, UserRole.admin)
  async getConfig(@Req() req: AuthedRequest) {
    return this.cadence.getTenantConfig(this.requireTenantId(req));
  }

  @Patch("config")
  @Roles(UserRole.owner, UserRole.admin)
  async updateConfig(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateRebookingConfigDto,
  ) {
    const tenantId = this.requireTenantId(req);
    const current = await this.cadence.getTenantConfig(tenantId);
    const merged = { ...current, ...dto };
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { rebookingSettings: merged as any },
    });
    return merged;
  }

  @Get("clients/:id/prediction")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async getPrediction(@Param("id") clientId: string) {
    await this.cadence.computeForClient(clientId);
    return this.prisma.clientCadence.findUnique({
      where: { clientId },
    });
  }

  @Get("clients/:id/log")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async getLog(@Param("id") clientId: string) {
    return this.prisma.rebookingReminder.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  @Post("clients/:id/opt-out")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async optOut(@Param("id") clientId: string) {
    await this.cadence.optOutClient(clientId);
    return { ok: true };
  }

  @Post("recompute/:clientId")
  @Roles(UserRole.owner, UserRole.admin)
  async recompute(@Param("clientId") clientId: string) {
    await this.cadence.computeForClient(clientId);
    return { ok: true };
  }

  /**
   * Public opt-out endpoint reachable from the footer link in the reminder
   * email. Auth-less by design (clients don't have accounts necessarily).
   * Validates an HMAC token bound to the clientId.
   */
  @Public()
  @Post("public/opt-out")
  async publicOptOut(@Query("token") token: string, @Query("client") clientId: string) {
    if (!token || !clientId) {
      throw new BadRequestException("token and client query params required");
    }
    const secret = this.resolveOptOutSecret();
    const expected = createHmac("sha256", secret)
      .update(clientId)
      .digest("hex")
      .slice(0, 32);
    if (
      expected.length !== token.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(token))
    ) {
      throw new BadRequestException("invalid token");
    }
    await this.cadence.optOutClient(clientId);
    return { ok: true };
  }

  private resolveOptOutSecret(): string {
    const secret = process.env.REBOOKING_OPT_OUT_SECRET;
    if (secret && secret.length >= 16) return secret;
    if (process.env.NODE_ENV === "production") {
      throw new BadRequestException(
        "rebooking is not configured for production",
      );
    }
    return "dev-secret-do-not-use-in-production";
  }

  private requireTenantId(req: AuthedRequest): string {
    const t = req.user?.tenantId;
    if (!t) throw new Error("Missing tenantId on authenticated request");
    return t;
  }
}