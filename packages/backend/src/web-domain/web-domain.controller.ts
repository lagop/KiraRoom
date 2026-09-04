import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { UserRole } from "@prisma/client";
import { WebDomainService } from "./web-domain.service";

@ApiTags("web-domain")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("web-domain")
export class WebDomainController {
  constructor(private readonly service: WebDomainService) {}

  @Get()
  @ApiOperation({ summary: "Estado del add-on web_domain del tenant" })
  status(@Req() req: any) {
    return this.service.getStatus(req.user.tenantId);
  }

  @Post("check-availability")
  @ApiOperation({ summary: "Comprueba disponibilidad de un dominio (mock)" })
  check(@Body() body: { domain: string }) {
    return this.service.checkAvailability(body.domain);
  }

  @Post("purchase")
  @Roles(UserRole.owner)
  @ApiOperation({ summary: "Inicia la compra del add-on web_domain" })
  purchase(@Req() req: any, @Body() body: { domain: string }) {
    return this.service.purchase(req.user.tenantId, body.domain);
  }

  @Post("configure")
  @Roles(UserRole.owner, UserRole.admin)
  @ApiOperation({ summary: "Configura dominio, SEO, sitemap del add-on" })
  configure(
    @Req() req: any,
    @Body() body: { domain?: string; seoTitle?: string; seoDescription?: string },
  ) {
    return this.service.configure(req.user.tenantId, body);
  }
}