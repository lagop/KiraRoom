import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  BadRequestException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { createHmac } from "crypto";
import * as ics from "ics";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { Public } from "../auth/decorators/public.decorator";
import { PrismaService } from "../common/prisma/prisma.service";

@ApiTags("ics-feeds")
@Controller("ics")
export class IcsController {
  private readonly logger = new Logger(IcsController.name);
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  @Get("professional/:id")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @ApiOperation({ summary: "ICS feed for a professional's appointments" })
  async professionalFeed(
    @Param("id") id: string,
    @Query("token") token: string,
    @Res() res: Response,
  ) {
    this.verifyToken(`professional:${id}`, token);
    const professional = await this.prisma.professional.findUnique({
      where: { id },
      include: { tenant: true },
    });
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
    @Param("id") id: string,
    @Query("token") token: string,
    @Res() res: Response,
  ) {
    this.verifyToken(`staff:${id}`, token);
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { professional: true, tenant: true },
    });
    if (!user || !user.tenant) throw new NotFoundException("Staff not found");
    const profIds = user.professionalId ? [user.professionalId] : [];
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
    this.verifyToken(`salon:${slug}`, token);
    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
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

  static signToken(scope: string, secret: string): string {
    return createHmac("sha256", secret).update(scope).digest("hex").slice(0, 32);
  }

  private verifyToken(scope: string, token: string) {
    const secret = this.config.get<string>("ICS_TOKEN_SECRET");
    if (!secret) throw new BadRequestException("ICS_TOKEN_SECRET not configured");
    if (!token) throw new BadRequestException("token query param required");
    const expected = IcsController.signToken(scope, secret);
    if (expected !== token) throw new BadRequestException("Invalid token");
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
        uid: `${a.id}@${tenant.slug}.kirastudio.app`,
        productId: "KiraStudio/ICS-Feed",
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