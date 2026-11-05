import { Body, Controller, Get, Patch, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { IsString, MaxLength } from "class-validator";
import { UserRole } from "@prisma/client";
import { Public } from "../auth/decorators/public.decorator";
import { Roles } from "../auth/decorators/roles.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { WebAddressService } from "./web-address.service";
import { NotDuringSupport } from "../common/decorators/not-during-support.decorator";

export class ChangeWebAddressDto {
  @IsString()
  @MaxLength(100)
  slug!: string;
}

/** D4: the salon's web address, chosen at signup and changed once from Ajustes > Web. */
@ApiTags("Web address")
@Controller("web-address")
export class WebAddressController {
  constructor(private readonly webAddress: WebAddressService) {}

  /** The signup form checks the address as it is typed (public, throttled). */
  @Get("availability")
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "Whether a web address can be used for a new salon (public)" })
  availability(@Query("slug") slug: string) {
    return this.webAddress.availability(slug ?? "");
  }

  @Get()
  @Roles(UserRole.owner)
  @ApiBearerAuth()
  @ApiOperation({ summary: "The salon's web address and whether it can still be changed (owner)" })
  current(@CurrentUser() user: { tenantId: string }) {
    return this.webAddress.current(user.tenantId);
  }

  /** Ajustes > Web: whether this salon could move to that address (owner). */
  @Get("check")
  @Roles(UserRole.owner)
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "Whether the salon could change to this address (owner)" })
  check(@CurrentUser() user: { tenantId: string }, @Query("slug") slug: string) {
    return this.webAddress.availability(slug ?? "", user.tenantId);
  }

  /** Once; the old address redirects (301) for 12 months, then is free. */
  @NotDuringSupport()
  @Patch()
  @Roles(UserRole.owner)
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: "Change the salon's web address, once (owner)" })
  change(@CurrentUser() user: { id: string; role: string; tenantId: string; impersonatedBy?: string }, @Body() dto: ChangeWebAddressDto) {
    return this.webAddress.change(user.tenantId, user, dto.slug);
  }
}
