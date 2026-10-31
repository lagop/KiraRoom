import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Redirect, Req, UseGuards } from "@nestjs/common";
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
import { Throttle } from "@nestjs/throttler";
import { EmailUnsubscribeService } from "../email-campaigns/email-unsubscribe.service";

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
    private readonly unsubscribes: EmailUnsubscribeService,
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
      data: { rebookingSettings: merged as any } });
    return merged;
  }

  @Get("clients/:id/prediction")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async getPrediction(@Param("id") clientId: string) {
    await this.cadence.computeForClient(clientId);
    return this.prisma.clientCadence.findUnique({
      where: { clientId } });
  }

  @Get("clients/:id/log")
  @Roles(UserRole.owner, UserRole.admin, UserRole.staff)
  async getLog(@Param("id") clientId: string) {
    return this.prisma.rebookingReminder.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      take: 50 });
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
   * Links in reminders sent before the shared unsubscribe link.
   *
   * Those emails pointed at the web app's /api/public/rebooking/opt-out,
   * which never existed (a click answered 404); the web app now forwards
   * that path here. Opening a link only describes, as with the campaigns'
   * link (a mail scanner must not unsubscribe anyone): a valid old link
   * redirects to the unsubscribe page of that client, whose button does it;
   * anything else lands on the same page saying the link is not valid.
   */
  @Public()
  @Get("public/opt-out")
  @Redirect()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  legacyOptOutPage(@Query("token") token: string, @Query("client") clientId: string) {
    const url = this.legacyTokenValid(token, clientId)
      ? this.unsubscribes.link({ kind: "c", id: clientId }).pageUrl
      : this.unsubscribes.pageUrl("invalido");
    return { url, statusCode: 302 };
  }

  /**
   * The old opt-out action (HMAC over the client id), kept for anything that
   * still posts to it. It now does what the shared unsubscribe link does:
   * suppression list, marketing refusal and rebooking opt-out.
   */
  @Public()
  @Post("public/opt-out")
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async publicOptOut(@Query("token") token: string, @Query("client") clientId: string) {
    if (!token || !clientId) {
      throw new BadRequestException("token and client query params required");
    }
    if (!this.legacyTokenValid(token, clientId)) {
      throw new BadRequestException("invalid token");
    }
    try {
      await this.unsubscribes.unsubscribe(this.unsubscribes.tokenFor({ kind: "c", id: clientId }));
    } catch {
      // A client without an email address: nothing to suppress, only the
      // rebooking reminders to stop.
      await this.cadence.optOutClient(clientId);
    }
    return { ok: true };
  }

  /** Whether `token` is the old opt-out signature of `clientId`. */
  private legacyTokenValid(token: unknown, clientId: unknown): boolean {
    if (typeof token !== "string" || typeof clientId !== "string" || !token || !clientId) return false;
    const secret = process.env.REBOOKING_OPT_OUT_SECRET;
    let key: string;
    if (secret && secret.length >= 16) key = secret;
    else if (process.env.NODE_ENV === "production") return false;
    else key = "dev-secret-do-not-use-in-production";
    const expected = Buffer.from(createHmac("sha256", key).update(clientId).digest("hex").slice(0, 32));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private requireTenantId(req: AuthedRequest): string {
    const t = req.user?.tenantId;
    if (!t) throw new Error("Missing tenantId on authenticated request");
    return t;
  }
}