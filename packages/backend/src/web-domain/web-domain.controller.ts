import { Body, Controller, Delete, Get, Post, Put, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { IsString, MaxLength } from "class-validator";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { WebDomainService } from "./web-domain.service";

export class SetWebDomainDto {
  @IsString()
  @MaxLength(300)
  domain!: string;
}

/**
 * The salon's own domain for its public page. Bring-your-own only: there is
 * no availability check or purchase any more (both were simulated).
 */
@ApiTags("web-domain")
@ApiBearerAuth()
@Controller("web-domain")
export class WebDomainController {
  constructor(private readonly service: WebDomainService) {}

  @Get()
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Public page URL and custom-domain state, with the DNS records to create" })
  status(@Req() req: any) {
    return this.service.getStatus(req.user.tenantId);
  }

  @Put()
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Set the salon's own domain (starts unverified)" })
  setDomain(@Req() req: any, @Body() body: SetWebDomainDto) {
    return this.service.setDomain(req.user.tenantId, body.domain);
  }

  // Each click runs three DNS lookups against the resolver.
  @Post("verify")
  @Roles(...SALON_MANAGERS)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Check the DNS records now" })
  verify(@Req() req: any) {
    return this.service.verify(req.user.tenantId);
  }

  @Delete()
  @Roles(...SALON_MANAGERS)
  @ApiOperation({ summary: "Disconnect the salon's domain" })
  remove(@Req() req: any) {
    return this.service.removeDomain(req.user.tenantId);
  }
}
