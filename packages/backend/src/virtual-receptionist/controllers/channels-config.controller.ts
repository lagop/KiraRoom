import { Body, Controller, Delete, Get, Logger, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { FeatureGuard } from '../../common/guards/feature.guard';
import { Feature } from '../../common/decorators/feature.decorator';
import { MetricsService, COUNTERS } from '../../common/observability/metrics.service';
import { UserRole } from '@prisma/client';
import { ChannelsConfigService } from '../services/channels-config.service';
import { ChannelConnectionsService } from '../services/channel-connections.service';

const CHANNELS = ['web', 'whatsapp', 'facebook', 'instagram', 'telegram'];

/**
 * The on/off switches. The body used to be typed with a zod-inferred type,
 * which the global ValidationPipe cannot see, so any JSON -- tokens
 * included -- was merged into the tenant's features as sent.
 */
export class UpdateChannelsSwitchesDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(CHANNELS, { each: true })
  enabledChannels?: string[];
}

export class ConnectTelegramBodyDto {
  @IsString()
  @MaxLength(200)
  @Matches(/^\d{6,12}:[A-Za-z0-9_-]{30,}$/, { message: 'Invalid Telegram bot token format' })
  botToken!: string;
}

export class SelectMetaPageDto {
  @IsString()
  @Matches(/^\d{1,40}$/)
  pageId!: string;
}

/**
 * P2A-receptionist-v2 H-4: tenant-facing endpoints to read and write
 * the multichannel configuration and to connect each channel.
 *
 * Gating:
 *   - JwtAuthGuard         → authenticated user required
 *   - RolesGuard           → only owner / admin can connect accounts
 *   - FeatureGuard         → tenant must have the `multichannel`
 *                            feature key (Pro / Empresa, or the add-on
 *                            on Esencial). Others get FEATURE_NOT_IN_PLAN.
 *
 * Public webhooks (`/channels/webhooks/{meta,telegram/:tenantId}`) are NOT
 * guarded here; they verify their own signatures in
 * `ChannelsWebhookController`.
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
    private readonly connections: ChannelConnectionsService,
    private readonly metrics: MetricsService,
  ) {}

  @Get('config')
  @ApiOperation({ summary: 'Get current multichannel configuration' })
  async getConfig(@Req() req: any) {
    const tenantId = req?.user?.tenantId;
    if (!tenantId) return null;
    const view = await this.service.getConfig(tenantId);
    return { ...view, availability: this.connections.availability() };
  }

  @Put('config')
  @ApiOperation({ summary: 'Turn channels on or off' })
  async updateConfig(
    @Req() req: any,
    @Body() dto: UpdateChannelsSwitchesDto,
  ) {
    const tenantId = req?.user?.tenantId;
    if (!tenantId) return null;
    this.logger.log(
      `Updating multichannel config for tenant ${tenantId}: enabled=${dto.enabled} channels=${(dto.enabledChannels ?? []).join(',')}`,
    );
    const view = await this.service.updateConfig(tenantId, dto);
    return { ...view, availability: this.connections.availability() };
  }

  /** Facebook Login URL: the salon picks the Page (and its Instagram) to connect. */
  @Get('meta/connect')
  @ApiOperation({ summary: 'Start connecting a Facebook Page (Messenger + Instagram)' })
  metaConnect(@Req() req: any) {
    return { url: this.connections.metaLoginUrl(req.user.tenantId) };
  }

  @Get('meta/pages')
  @ApiOperation({ summary: 'Pages to choose from after Facebook Login' })
  metaPages(@Req() req: any) {
    return this.connections.pendingPages(req.user.tenantId);
  }

  @Post('meta/select')
  @ApiOperation({ summary: 'Connect one of the Pages offered after Facebook Login' })
  metaSelect(@Req() req: any, @Body() dto: SelectMetaPageDto) {
    return this.connections.selectPage(req.user.tenantId, dto.pageId);
  }

  @Delete('meta')
  @ApiOperation({ summary: 'Disconnect the Facebook Page' })
  metaDisconnect(@Req() req: any) {
    return this.connections.disconnectMeta(req.user.tenantId);
  }

  @Post('telegram')
  @ApiOperation({ summary: 'Connect a Telegram bot (token from @BotFather)' })
  telegramConnect(@Req() req: any, @Body() dto: ConnectTelegramBodyDto) {
    return this.connections.connectTelegram(req.user.tenantId, dto.botToken);
  }

  @Delete('telegram')
  @ApiOperation({ summary: 'Disconnect the Telegram bot' })
  telegramDisconnect(@Req() req: any) {
    return this.connections.disconnectTelegram(req.user.tenantId);
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
    summary: 'Get current per-channel volume for this tenant' })
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

/**
 * Where Facebook Login sends the browser back. Public because the browser
 * comes from facebook.com without our session; the HMAC-signed `state`
 * says which salon started the login, and expires in 15 minutes.
 */
@ApiTags('virtual-receptionist')
@Controller('channels/meta')
export class ChannelsMetaCallbackController {
  constructor(private readonly connections: ChannelConnectionsService) {}

  @Get('callback')
  @Public()
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const back = `${this.connections.frontendBase()}/dashboard/settings/channels`;
    if (error || !code || !state) {
      return res.redirect(302, `${back}?meta=${error ? 'denied' : 'error'}`);
    }
    const { outcome } = await this.connections.completeMetaLogin(code, state);
    return res.redirect(302, `${back}?meta=${outcome}`);
  }
}
