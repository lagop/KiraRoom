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
import { salonInstant } from "../appointments/salon-time";
import { salonToday } from "../analytics/analytics-metrics";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEZONE = "Europe/Madrid";

/** How far back and ahead a feed reaches, in the salon's calendar days. */
export const ICS_PAST_DAYS = 30;
export const ICS_FUTURE_DAYS = 180;
/** Far above any salon's appointments in the window; only there so a feed can never be unbounded. */
const ICS_MAX_EVENTS = 20_000;

/**
 * What a feed shows: pending online bookings (marked as tentative, since
 * autoConfirmOnlineBookings is off by default and they used to be left out
 * until someone confirmed them) and every appointment that goes ahead.
 * Cancelled ones and no-shows are not in it.
 */
export const ICS_STATUSES = ["pending", "confirmed", "in_progress", "completed"] as const;

/**
 * The feed's date window: from ICS_PAST_DAYS before the salon's today to
 * ICS_FUTURE_DAYS after it, on scheduledDate (a calendar day). The feeds used
 * to take the first 500/1000 rows from 30 days ago, oldest first, so a busy
 * salon's upcoming appointments fell off the end.
 */
export function icsWindow(timeZone: string | null | undefined, now: Date = new Date()): { gte: Date; lte: Date } {
  const today = Date.parse(`${salonToday(timeZone || DEFAULT_TIMEZONE, now)}T00:00:00.000Z`);
  return { gte: new Date(today - ICS_PAST_DAYS * DAY_MS), lte: new Date(today + ICS_FUTURE_DAYS * DAY_MS) };
}

/** The appointments filter every feed shares. */
function feedWhere(timeZone: string | null | undefined) {
  return { status: { in: [...ICS_STATUSES] }, scheduledDate: icsWindow(timeZone) };
}

/**
 * What a feed reads of an appointment's client and service: the client's
 * first name only. A feed lives in Google, Apple or Outlook, outside
 * KiraRoom, so it carries no surname, phone, email or notes.
 */
const FEED_INCLUDE = {
  client: { select: { firstName: true } },
  service: { select: { name: true } },
} as const;

/**
 * The calendar events of a feed. An appointment's date and "HH:MM" are the
 * salon's wall clock: the instant comes from the salon's timezone and goes
 * out in UTC ("…Z"), so Google, Apple and Outlook show it at the right hour
 * wherever the server runs. It used to read the time in the server's zone
 * (UTC in the container) and send it as UTC: every appointment was an hour
 * late in winter and two in summer.
 *
 * Every feed type shows the service and the client's first name, nothing
 * else about her: no surname, no phone or email, and no notes (they held
 * allergies and health remarks, copied into third-party calendars).
 */
export function buildIcsEvents(appointments: any[], tenant: any): ics.EventAttributes[] {
  const timeZone: string = tenant.timezone || DEFAULT_TIMEZONE;
  return appointments.map<ics.EventAttributes>((a) => {
    const start = salonInstant(a.scheduledDate, validClock(a.scheduledTime), timeZone).getTime();
    const duration: number = a.duration ?? 60;
    const clientName = String(a.client?.firstName ?? "").trim() || "Cliente";
    const serviceName = a.service?.name ?? "Servicio";
    const pending = a.status === "pending";
    return {
      title: `${pending ? "Por confirmar · " : ""}${serviceName} - ${clientName}`,
      start,
      startInputType: "utc",
      startOutputType: "utc",
      end: start + duration * 60 * 1000,
      endInputType: "utc",
      endOutputType: "utc",
      status: pending ? "TENTATIVE" : "CONFIRMED",
      location: [tenant.street, tenant.city, tenant.country].filter(Boolean).join(", "),
      uid: `${a.id}@${tenant.slug}.kiraroom.app`,
      productId: "KiraRoom/ICS-Feed",
      calName: `${tenant.name} — Calendario`,
    };
  });
}

/** "HH:MM", or 09:00 for a missing or malformed time (as before). */
function validClock(time: unknown): string {
  return typeof time === "string" && /^([01]?\d|2[0-3]):[0-5]\d/.test(time) ? time.slice(0, 5) : "09:00";
}

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
    // Only those still working here: a deactivated professional's feed answers 404.
    const professionals = await this.prisma.professional.findMany({
      where: { tenantId, isActive: true },
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
   * Revokes every feed link of the caller's salon (salon and professional
   * feeds) and returns the new ones.
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
    // A professional who has left (deactivated) no longer has a feed: their
    // calendar link stops answering, as their panel login does.
    if (!professional || !professional.isActive) throw new NotFoundException("Professional not found");
    const appointments = await this.prisma.appointment.findMany({
      where: {
        professionalId: id,
        ...feedWhere(professional.tenant?.timezone),
      },
      include: FEED_INCLUDE,
      orderBy: [{ scheduledDate: "asc" }, { scheduledTime: "asc" }],
      take: ICS_MAX_EVENTS,
    });
    const events = buildIcsEvents(appointments, professional.tenant);
    return this.send(res, events, `professional-${id}.ics`);
  }

  // No /ics/staff/:id: nothing ever issued a staff token (tokens() signs
  // only the salon and its professionals), so the route was dead.

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
        ...feedWhere(tenant.timezone),
      },
      include: FEED_INCLUDE,
      orderBy: [{ scheduledDate: "asc" }, { scheduledTime: "asc" }],
      take: ICS_MAX_EVENTS,
    });
    return this.send(res, buildIcsEvents(appointments, tenant), `salon-${slug}.ics`);
  }

  /**
   * Version 0 signs the bare scope, exactly as before versions existed, so
   * links handed out earlier keep verifying. Later versions sign
   * `v<n>:<scope>`; every scope starts with a word (salon:, professional:),
   * so no versioned input can equal an unversioned one.
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

  private send(res: Response, events: ics.EventAttributes[], filename: string) {
    const { error, value } = ics.createEvents(events);
    if (error) {
      this.logger.error(`ICS build error: ${error.message}`);
      res.status(500);
      return res.send("ICS generation failed");
    }
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // Clients' names and appointments: no shared cache (proxy, CDN) may keep a copy.
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(value);
  }
}