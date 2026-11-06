import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpsellService } from './upsell.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles, SALON_TEAM } from "../auth/decorators/roles.decorator";

@Controller('upsell')
@UseGuards(JwtAuthGuard)
export class UpsellController {
  constructor(private readonly svc: UpsellService) {}

  /**
   * Read-only endpoint. The orchestrator's LLM-side call is the
   * primary consumer (via `UpsellService.suggest()`), but this route
   * lets the dashboard preview the same data.
   */
  @Get('suggest')
  @Roles(...SALON_TEAM)
  async suggest(
    @CurrentUser() user: { tenantId: string },
    @Query('clientId') clientId?: string,
    @Query('excludeServiceIds') excludeServiceIds?: string,
  ) {
    const exclude = excludeServiceIds
      ? excludeServiceIds.split(',').filter(Boolean)
      : undefined;
    // The salon is the caller's: a ?tenantId= from the URL is no longer read.
    return this.svc.suggest(user.tenantId, { clientId, excludeServiceIds: exclude });
  }
}
