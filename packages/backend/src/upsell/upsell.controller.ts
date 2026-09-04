import { ParseUUIDPipe, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpsellService } from './upsell.service';

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
  async suggest(
    @Query('tenantId') tenantId: string,
    @Query('clientId') clientId?: string,
    @Query('excludeServiceIds') excludeServiceIds?: string,
  ) {
    const exclude = excludeServiceIds
      ? excludeServiceIds.split(',').filter(Boolean)
      : undefined;
    return this.svc.suggest(tenantId, { clientId, excludeServiceIds: exclude });
  }
}
