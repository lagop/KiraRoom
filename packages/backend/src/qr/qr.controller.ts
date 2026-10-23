import { ParseUUIDPipe, Controller, Get, Param, Query, Res, NotFoundException } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import * as QRCode from "qrcode";
import type { Response } from "express";
import { Public } from "../auth/decorators/public.decorator";
import { PrismaService } from "../common/prisma/prisma.service";
import { salonPublicUrlFromEnv } from "../web-domain/public-url";

const TENANT_ADDRESS = { slug: true, customDomain: { select: { domain: true, verifiedAt: true } } } as const;

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
    const tenant = await this.prisma.tenant.findUnique({ where: { slug }, select: TENANT_ADDRESS });
    if (!tenant) throw new NotFoundException("Salon not found");
    const url = this.publicSiteUrl(tenant);
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
      include: { tenant: { select: TENANT_ADDRESS } },
    });
    if (!professional || !professional.tenant) {
      throw new NotFoundException("Professional not found");
    }
    const url = this.publicSiteUrl(
      professional.tenant,
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
      include: { tenant: { select: TENANT_ADDRESS } },
    });
    if (!service || !service.tenant) {
      throw new NotFoundException("Service not found");
    }
    const url = this.publicSiteUrl(
      service.tenant,
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

  /**
   * The salon's page at its real address: own domain or subdomain, else
   * /sites/<slug> (salonPublicUrlFromEnv). Codes printed with the old
   * address keep working: it redirects, query string included.
   */
  private publicSiteUrl(
    tenant: { slug: string; customDomain?: { domain: string; verifiedAt: Date | null } | null },
    suffix = "",
  ): string {
    const base = salonPublicUrlFromEnv(tenant.slug, tenant.customDomain);
    return suffix.startsWith("?") ? `${base}/${suffix}` : `${base}${suffix}`;
  }
}