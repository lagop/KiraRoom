import { Controller, Get, NotFoundException } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Roles, SALON_TEAM } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { PrismaService } from "../common/prisma/prisma.service";
import { salonPublicUrlFromEnv } from "../web-domain/public-url";

const TENANT_ADDRESS = { slug: true, customDomain: { select: { domain: true, verifiedAt: true } } } as const;

/**
 * The public /qr/salon, /qr/professional and /qr/service image endpoints
 * are gone: nothing used them (the panel draws its codes in the browser),
 * and they rendered a QR for any salon, professional or service id.
 */
@ApiTags("qr")
@Controller("qr")
export class QrController {
  constructor(private prisma: PrismaService) {}

  /**
   * What the dashboard needs to share and print the salon page: its name,
   * logo and real address (own domain, subdomain or /sites/<slug>). The QR
   * codes themselves are drawn in the browser from this address, so the
   * page, the printables and the image for social media all match.
   * `ownDomain` says the address is the salon's own domain: printed codes
   * then work only while the salon keeps that domain.
   */
  @Get("share")
  @Roles(...SALON_TEAM)
  @ApiOperation({ summary: "The salon public address, name and logo, for sharing and printing" })
  async share(@CurrentUser() user: { tenantId: string }) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { name: true, logo: true, ...TENANT_ADDRESS },
    });
    if (!tenant) throw new NotFoundException("Salon not found");
    const url = salonPublicUrlFromEnv(tenant.slug, tenant.customDomain);
    const domain = tenant.customDomain?.domain?.toLowerCase();
    return {
      name: tenant.name,
      slug: tenant.slug,
      logo: tenant.logo ?? null,
      url,
      ownDomain: !!domain && new URL(url).hostname.toLowerCase() === domain,
    };
  }
}
