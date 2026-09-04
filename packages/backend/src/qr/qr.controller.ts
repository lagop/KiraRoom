import { ParseUUIDPipe, Controller, Get, Param, Query, Res, NotFoundException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import * as QRCode from "qrcode";
import type { Response } from "express";
import { Public } from "../auth/decorators/public.decorator";
import { PrismaService } from "../common/prisma/prisma.service";

@ApiTags("qr")
@Controller("qr")
export class QrController {
  constructor(private prisma: PrismaService) {}

  @Get("salon/:slug")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @ApiOperation({ summary: "QR code linking to the salon public page" })
  async salonQr(
    @Param("slug") slug: string,
    @Query("format") format: "png" | "svg" = "png",
    @Res() res: Response,
  ) {
    const tenant = await this.prisma.tenant.findUnique({ where: { slug } });
    if (!tenant) throw new NotFoundException("Salon not found");
    const url = this.publicSiteUrl(tenant.slug);
    return this.render(res, url, format, `salon-${slug}`);
  }

  @Get("professional/:id")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @ApiOperation({ summary: "QR code linking to a salon filtered by professional" })
  async professionalQr(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("format") format: "png" | "svg" = "png",
    @Res() res: Response,
  ) {
    const professional = await this.prisma.professional.findUnique({
      where: { id },
      include: { tenant: true },
    });
    if (!professional || !professional.tenant) {
      throw new NotFoundException("Professional not found");
    }
    const url = this.publicSiteUrl(
      professional.tenant.slug,
      `?professionalId=${professional.id}`,
    );
    return this.render(res, url, format, `professional-${id}`);
  }

  @Get("service/:id")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @ApiOperation({ summary: "QR code linking to a salon filtered by service" })
  async serviceQr(
    @Param("id", ParseUUIDPipe) id: string,
    @Query("format") format: "png" | "svg" = "png",
    @Res() res: Response,
  ) {
    const service = await this.prisma.service.findUnique({
      where: { id },
      include: { tenant: true },
    });
    if (!service || !service.tenant) {
      throw new NotFoundException("Service not found");
    }
    const url = this.publicSiteUrl(
      service.tenant.slug,
      `?serviceId=${service.id}`,
    );
    return this.render(res, url, format, `service-${id}`);
  }

  private async render(
    res: Response,
    url: string,
    format: "png" | "svg",
    cacheKey: string,
  ) {
    res.setHeader(
      "Cache-Control",
      "public, max-age=3600, immutable",
    );
    if (format === "svg") {
      const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M" });
      res.setHeader("Content-Type", "image/svg+xml");
      return res.send(svg);
    }
    const png = await QRCode.toBuffer(url, { type: "png", errorCorrectionLevel: "M", width: 512 });
    res.setHeader("Content-Type", "image/png");
    return res.send(png);
  }

  private publicSiteUrl(slug: string, suffix = ""): string {
    const base =
      process.env.FRONTEND_URL?.replace(/\/$/, "") || "http://localhost:3000";
    return `${base}/sites/${slug}${suffix}`;
  }
}