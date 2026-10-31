import { ParseUUIDPipe, Controller, Get, Post, HttpCode, HttpStatus, Param, Query, Res, Req, UseGuards, BadRequestException, NotFoundException, Logger } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { createHmac, timingSafeEqual } from "crypto";
import * as ics from "ics";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { Public } from "../auth/decorators/public.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";

/**
 * The salon's feed-token version, kept in `Tenant.features.icsFeed.version`.
 *
 * Feed tokens are HMACs of a scope and never expired, so a leaked link was
 * good forever. Rotating bumps this version and every token the salon has
 * handed out stops verifying. A salon that never rotated has no key here and
 * is at version 0, whose tokens are the old unversioned ones: calendars that
 * are already subscribed keep working until the salon rotates.
 *
 * Anything that is not a non-negative integer reads as 0. Only the rotate
 * endpoint writes the key.
 */
export function icsFeedVersion(features: unknown): number {
  const version = (features as any)?.icsFeed?.version;
  return Number.isSafeInteger(version) && version > 0 ? version : 0;
}

@ApiTags("ics-feeds")
@Controller("ics")
export class IcsController {
  private readonly logger = new Logger(IcsController.name);
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  /**
   * The signed feed tokens for the caller's own salon and its professionals.
   *
   * The calendar-feeds page used to hand out URLs ending in
   * ?token=REEMPLAZAR_CON_TOKEN and point at this endpoint as "coming soon",
   * so no feed it offered could ever load.
   */
  @Get("tokens")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Signed ICS feed tokens for the caller's salon" })
  async tokens(@Req() req: any) {
    const secret = this.config.get<string>("ICS_TOKEN_SECRET");
    if (!secret) throw new BadRequestException("ICS_TOKEN_SECRET not configured");
    const tenantId: string = req.user.tenantId;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, features: true },
    });
    if (!tenant) throw new NotFoundException("Salon not found");
    const version = icsFeedVersion(tenant.features);
    const rotatedAt = (tenant.features as any)?.icsFeed?.rotatedAt ?? null;
    const professionals = await this.prisma.professional.findMany({
      where: { tenantId },
      select: { id: true, firstName: true, lastName: true },
      orderBy: { firstName: "asc" },
    });
    return {
      version,
      rotatedAt: version > 0 ? rotatedAt : null,
      salon: { slug: tenant.slug, token: IcsController.signToken(`salon:${tenant.slug}`, secret, version) },
      professionals: professionals.map((p) => ({
        id: p.id,
        name: `${p.firstName} ${p.lastName}`.trim(),
        token: IcsController.signToken(`professional:${p.id}`, secret, version),
      })),
    };
  }

  /**
   * Revokes every feed link of the caller's salon (salon, professional and
   * staff feeds) and returns the new ones.
   *
   * One atomic UPDATE: the version is incremented inside Postgres, so two
   * clicks can never land on the same version, and the rest of `features` is
   * left as it is. $queryRaw bypasses the tenant-scope extension, hence the
   * explicit id filter.
   *
   * Known gap: the channel settings save `features` with a read-modify-write
   * through Prisma. One that read `features` before this UPDATE and writes
   * after it would put the old version back and revive the old links. The
   * window is a few milliseconds and needs both saves at once from the same
   * salon. A dedicated column (`Tenant.icsFeedVersion Int @default(0)`)
   * would close it.
   */
  @Post("tokens/rotate")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Revoke the salon's ICS feed links and issue new ones" })
  async rotateTokens(@Req() req: any) {
    const secret = this.config.get<string>("ICS_TOKEN_SECRET");
    if (!secret) throw new BadRequestException("ICS_TOKEN_SECRET not configured");
    const tenantId: string = req.user.tenantId;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "tenants"
      SET "features" = jsonb_set(
            CASE WHEN jsonb_typeof("features") = 'object' THEN "features" ELSE '{}'::jsonb END,
            '{icsFeed}',
            jsonb_build_object(
              'version', COALESCE(("features"->'icsFeed'->>'version')::int, 0) + 1,
              'rotatedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            ),
            true
          ),
          "updatedAt" = NOW()
      WHERE "id" = ${tenantId}
      RETURNING "id"`;
    if (rows.length === 0) throw new NotFoundException("Salon not found");
    this.logger.log(`ICS feed links rotated for tenant ${tenantId}`);
    return this.tokens(req);
  }

  @Get("professional/:id")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @ApiOperation({ summary: "ICS feed for a professional's appointments" })
  async professionalFeed(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("token") token: string,
    @Res() res: Response,
  ) {
    this.requireToken(token);
    const professional = await this.prisma.professional.findUnique({
      where: { id },
      include: { tenant: true },
    });
    this.verifyToken(`professional:${id}`, token, professional ? icsFeedVersion(professional.tenant?.features) : null);
    if (!professional) throw new NotFoundException("Professional not found");
    const appointments = await this.prisma.appointment.findMany({
      where: {
        professionalId: id,
        status: { in: ["confirmed", "completed", "in_progress"] },
        scheduledDate: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      include: { client: true, service: true },
      orderBy: { scheduledDate: "asc" },
      take: 500,
    });
    const events = this.buildEvents(appointments, professional.tenant);
    return this.send(res, events, `professional-${id}.ics`);
  }

  @Get("staff/:id")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @ApiOperation({ summary: "ICS feed for a staff member (any professional they cover)" })
  async staffFeed(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("token") token: string,
    @Res() res: Response,
  ) {
    this.requireToken(token);
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { professional: true, tenant: true },
    });
    this.verifyToken(`staff:${id}`, token, user?.tenant ? icsFeedVersion(user.tenant.features) : null);
    if (!user || !user.tenant) throw new NotFoundException("Staff not found");
    // The link lives on Professional.userId; User.professionalId is never set.
    const profIds = user.professional ? [user.professional.id] : [];
    const appointments = await this.prisma.appointment.findMany({
      where: {
        tenantId: user.tenantId,
        ...(profIds.length > 0
          ? { professionalId: { in: profIds } }
          : { tenantId: user.tenantId }),
        status: { in: ["confirmed", "completed", "in_progress"] },
        scheduledDate: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      include: { client: true, service: true },
      orderBy: { scheduledDate: "asc" },
      take: 500,
    });
    return this.send(res, this.buildEvents(appointments, user.tenant), `staff-${id}.ics`);
  }

  @Get("salon/:slug")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @ApiOperation({ summary: "ICS feed for a whole salon (all professionals aggregated)" })
  async salonFeed(
    @Param("slug") slug: string,
    @Query("token") token: string,
    @Res() res: Response,
  ) {
    this.requireToken(token);
    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    this.verifyToken(`salon:${slug}`, token, tenant ? icsFeedVersion(tenant.features) : null);
    if (!tenant) throw new NotFoundException("Salon not found");
    const appointments = await this.prisma.appointment.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: ["confirmed", "completed", "in_progress"] },
        scheduledDate: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      include: { client: true, service: true },
      orderBy: { scheduledDate: "asc" },
      take: 1000,
    });
    return this.send(res, this.buildEvents(appointments, tenant), `salon-${slug}.ics`);
  }

  /**
   * Version 0 signs the bare scope, exactly as before versions existed, so
   * links handed out earlier keep verifying. Later versions sign
   * `v<n>:<scope>`; every scope starts with a word (salon:, professional:,
   * staff:), so no versioned input can equal an unversioned one.
   */
  static signToken(scope: string, secret: string, version = 0): string {
    const input = version > 0 ? `v${version}:${scope}` : scope;
    return createHmac("sha256", secret).update(input).digest("hex").slice(0, 32);
  }

  private requireToken(token: string) {
    if (!this.config.get<string>("ICS_TOKEN_SECRET")) {
      throw new BadRequestException("ICS_TOKEN_SECRET not configured");
    }
    if (!token) throw new BadRequestException("token query param required");
  }

  /**
   * `version` is the owning salon's current feed version, or null when the
   * feed's entity does not exist. A missing entity answers like a bad token,
   * so the feeds do not say which ids exist.
   */
  private verifyToken(scope: string, token: string, version: number | null = 0) {
    this.requireToken(token);
    const secret = this.config.get<string>("ICS_TOKEN_SECRET") as string;
    if (version === null) throw new BadRequestException("Invalid token");
    const expected = Buffer.from(IcsController.signToken(scope, secret, version));
    const given = Buffer.from(String(token));
    // Constant time: a plain !== leaks how many leading characters match.
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new BadRequestException("Invalid token");
    }
  }

  private buildEvents(appointments: any[], tenant: any): ics.EventAttributes[] {
    return appointments.map((a) => {
      const start = this.toDate(a.scheduledDate, a.scheduledTime);
      const duration: number = a.duration ?? 60;
      const end = new Date(start.getTime() + duration * 60 * 1000);
      const clientName = a.client
        ? `${a.client.firstName} ${a.client.lastName}`
        : "Cliente";
      const serviceName = a.service?.name ?? "Servicio";
      return {
        title: `${serviceName} - ${clientName}`,
        start: this.toIcsDate(start),
        end: this.toIcsDate(end),
        location: [tenant.street, tenant.city, tenant.country].filter(Boolean).join(", "),
        description: a.notes || "",
        uid: `${a.id}@${tenant.slug}.kiraroom.app`,
        productId: "KiraRoom/ICS-Feed",
        calName: `${tenant.name} — Calendario`,
      };
    });
  }

  private toIcsDate(d: Date): [number, number, number, number, number] {
    return [
      d.getUTCFullYear(),
      d.getUTCMonth() + 1,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
    ];
  }

  private toDate(scheduledDate: Date | string, scheduledTime: string): Date {
    const base = new Date(scheduledDate);
    const [hh, mm] = (scheduledTime || "09:00").split(":").map((n) => parseInt(n, 10));
    base.setHours(hh ?? 9, mm ?? 0, 0, 0);
    return base;
  }

  private send(res: Response, events: ics.EventAttributes[], filename: string) {
    const { error, value } = ics.createEvents(events);
    if (error) {
      this.logger.error(`ICS build error: ${error.message}`);
      res.status(500);
      return res.send("ICS generation failed");
    }
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.send(value);
  }
}