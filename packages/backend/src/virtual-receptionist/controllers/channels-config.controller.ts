import { ParseUUIDPipe, Body, Controller, Get, Logger, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { FeatureGuard } from '../../common/guards/feature.guard';
import { Feature } from '../../common/decorators/feature.decorator';
import { MetricsService, COUNTERS } from '../../common/observability/metrics.service';
import { UserRole } from '@prisma/client';
import { UpdateChannelsConfigDto } from '@kira/shared';
import { ChannelsConfigService } from '../services/channels-config.service';

/**
 * P2A-receptionist-v2 H-4: tenant-facing endpoints to read and write
 * the multichannel configuration.
 *
 * Gating:
 *   - JwtAuthGuard         → authenticated user required
 *   - RolesGuard           → only owner / admin can write credentials
 *   - FeatureGuard         → tenant must have the `multichannel`
 *                            feature key (Pro+ / Empresa). Esencial
 *                            tenants get FEATURE_NOT_IN_PLAN.
 *
 * Public webhooks (`/channels/webhooks/{meta,telegram}`) are NOT
 * guarded here; they are checked at the dispatcher entry point inside
 * `ChannelsWebhookController.handleMeta` / `handleTelegram`.
 */
@ApiTags('virtual-receptionist')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Roles(UserRole.owner, UserRole.admin)
@Feature('multichannel')
@Controller('virtual-receptionist/channels')
export class ChannelsConfigController {
  private readonly logger = new Logger(ChannelsConfigController.name);

  constructor(
    private readonly service: ChannelsConfigService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('config')
  @ApiOperation({ summary: 'Get current multichannel configuration' })
  async getConfig(@Req() req: any) {
    const tenantId = req?.user?.tenantId;
    if (!tenantId) return null;
    return this.service.getConfig(tenantId);
  }

  @Put('config')
  @ApiOperation({ summary: 'Update multichannel configuration' })
  async updateConfig(
    @Req() req: any,
    @Body() dto: UpdateChannelsConfigDto,
  ) {
    const tenantId = req?.user?.tenantId;
    if (!tenantId) return null;
    this.logger.log(
      `Updating multichannel config for tenant ${tenantId}: enabled=${dto.enabled} channels=${(dto.enabledChannels ?? []).join(',')}`,
    );
    return this.service.updateConfig(tenantId, dto);
  }

  /**
   * H-4: per-channel volume counters for the dashboard. The shape
   * is `{ inbound: { channel: n }, outbound: { channel: { ok, skipped, error } },
   * gateBlocked: { channel: { no_feature, lookup_error } } }`.
   *
   * Counts are process-local (Prometheus also scrapes the
   * authoritative `vrm_channel_*` series at `/internal/metrics`);
   * this endpoint is the tenant-scoped JSON view.
   */
  @Get('metrics')
  @ApiOperation({
    summary: 'Get current per-channel volume for this tenant',
  })
  async getChannelMetrics(): Promise<{
    inbound: Record<string, number>;
    outbound: Record<string, { ok: number; skipped: number; error: number }>;
    gateBlocked: Record<string, { no_feature: number; lookup_error: number }>;
  }> {
    const channels = ['web', 'whatsapp', 'facebook', 'instagram', 'telegram'];
    const emptyOutbound = () => ({ ok: 0, skipped: 0, error: 0 });
    const emptyGate = () => ({ no_feature: 0, lookup_error: 0 });
    const inbound: Record<string, number> = {};
    const outbound: Record<string, { ok: number; skipped: number; error: number }> = {};
    const gateBlocked: Record<string, { no_feature: number; lookup_error: number }> = {};
    for (const c of channels) {
      inbound[c] = 0;
      outbound[c] = emptyOutbound();
      gateBlocked[c] = emptyGate();
    }

    const inboundSnap = this.metrics
      .counter(COUNTERS.CHANNEL_INBOUND, '')
      .snapshot();
    const outboundSnap = this.metrics
      .counter(COUNTERS.CHANNEL_OUTBOUND, '')
      .snapshot();
    const gateSnap = this.metrics
      .counter(COUNTERS.CHANNEL_GATE_BLOCKED, '')
      .snapshot();
    for (const row of inboundSnap) {
      const ch = row.labels.channel;
      if (ch && ch in inbound) inbound[ch] += row.value;
    }
    for (const row of outboundSnap) {
      const ch = row.labels.channel;
      const res = row.labels.result as 'ok' | 'skipped' | 'error' | undefined;
      if (ch && ch in outbound && res) outbound[ch][res] += row.value;
    }
    for (const row of gateSnap) {
      const ch = row.labels.channel;
      const reason = row.labels.reason as 'no_feature' | 'lookup_error' | undefined;
      if (ch && ch in gateBlocked && reason) gateBlocked[ch][reason] += row.value;
    }

    return { inbound, outbound, gateBlocked };
  }
}