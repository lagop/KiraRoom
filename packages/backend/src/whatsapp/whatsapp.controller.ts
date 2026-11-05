import { Controller, Get, Post, Delete, Body, Req, UseGuards, Query, Headers, Res, GoneException, HttpCode, HttpStatus, Logger } from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Public } from "../auth/decorators/public.decorator";
import { OptOutNotRecordedError, WhatsAppService } from "./whatsapp.service";
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from "class-validator";

/**
 * Manual connection with the salon's own Meta credentials. Was an inline
 * type; the WABA and phone-number ids go into Graph API paths, so they
 * must be the numeric ids Meta gives, nothing else.
 */
export class ManualWhatsAppConnectDto {
  @IsString() @IsNotEmpty() @MaxLength(1000)
  accessToken!: string;

  @Matches(/^\d{1,30}$/, { message: "wabaId must be the numeric id Meta shows" })
  wabaId!: string;

  @Matches(/^\d{1,30}$/, { message: "phoneNumberId must be the numeric id Meta shows" })
  phoneNumberId!: string;

  /** Optional: the number is read from Meta. Kept for older panels that still send it. */
  @IsOptional() @IsString() @MaxLength(30)
  displayPhone?: string;

  @IsOptional() @IsString() @MaxLength(200)
  displayName?: string;
}

/**
 * "Conectar con Meta" (OAuth) is switched off: it saved the token only, with
 * no WhatsApp Business account or number, so the panel said "Conectado"
 * while nothing could be sent. The panel no longer offers it; these routes
 * answer 410 until the embedded signup (a pending decision) is built. Its
 * code is gone: a weakly signed state (no expiry, a "kira-dev" fallback
 * secret, not bound to the session) and a callback that answered JSON.
 * The embedded signup should reuse ChannelConnectionsService's state
 * (expiry, OAUTH_STATE_SECRET, session nonce). The manual connection is
 * unaffected.
 */
export const WHATSAPP_OAUTH_UNAVAILABLE =
  "La conexión automática con Meta no está disponible todavía. Conecta tu número de WhatsApp Business con la conexión manual, en Ajustes > WhatsApp Business.";

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

@ApiTags("whatsapp")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Controller("whatsapp")
export class WhatsAppController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  @Get("connect/start")
  @Roles(...SALON_MANAGERS)
  start() {
    throw new GoneException(WHATSAPP_OAUTH_UNAVAILABLE);
  }

  @Get("connect/callback")
  @Public()
  callback() {
    throw new GoneException(WHATSAPP_OAUTH_UNAVAILABLE);
  }

  @Post("connect/manual")
  @Roles(...SALON_MANAGERS)
  async manual(
    @Req() req: AuthedRequest,
    @Body() body: ManualWhatsAppConnectDto,
  ) {
    return this.whatsapp.manualConnect(req.user.tenantId, body);
  }

  @Get("connection")
  @Roles(...SALON_MANAGERS)
  async getConnection(@Req() req: AuthedRequest) {
    return this.whatsapp.getConnection(req.user.tenantId);
  }

  /** Whether KiraRoom can receive WhatsApp messages at all (the platform's Meta app), for the guide. */
  @Get("setup")
  @Roles(...SALON_MANAGERS)
  setup() {
    return this.whatsapp.setupStatus();
  }

  /** "Probar recepción": the time from which an event from Meta proves reception. */
  @Post("connection/reception-test")
  @Roles(...SALON_MANAGERS)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async receptionTest(@Req() req: AuthedRequest) {
    return this.whatsapp.startReceptionTest(req.user.tenantId);
  }

  /** Checks the stored token and number with Meta again and re-subscribes the webhook. */
  @Post("connection/check")
  @Roles(...SALON_MANAGERS)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async check(@Req() req: AuthedRequest) {
    return this.whatsapp.checkConnection(req.user.tenantId);
  }

  @Delete("connection")
  @Roles(...SALON_MANAGERS)
  async disconnect(@Req() req: AuthedRequest) {
    return this.whatsapp.disconnect(req.user.tenantId);
  }

  @Get("templates/standard")
  @Roles(...SALON_MANAGERS)
  async standardTemplateStatus(@Req() req: AuthedRequest) {
    return this.whatsapp.standardTemplateStatus(req.user.tenantId);
  }

  @Post("templates/standard")
  @Roles(...SALON_MANAGERS)
  async submitStandardTemplates(@Req() req: AuthedRequest) {
    return this.whatsapp.submitStandardTemplates(req.user.tenantId);
  }

  @Get("templates")
  @Roles(...SALON_MANAGERS)
  async templates(@Req() req: AuthedRequest) {
    return this.whatsapp.listTemplates(req.user.tenantId);
  }

  // Campaigns: WhatsAppCampaignsController (campaigns/), scoped to the salon.
}

/**
 * The platform console's view of KiraRoom's Meta app: which settings are
 * present (never their values) and the webhook URLs to give Meta.
 */
@ApiTags("platform-meta")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("platform/meta-status")
export class PlatformMetaStatusController {
  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Roles("saas_owner")
  get() {
    const raw = this.config.get<string>("API_BASE_URL")?.trim();
    const base = raw ? raw.replace(/\/+$/, "").replace(/\/api\/v1$/, "") + "/api/v1" : null;
    return {
      ...this.whatsapp.platformStatus(),
      webhookUrls: base
        ? { whatsapp: `${base}/webhooks/meta/whatsapp`, messengerInstagram: `${base}/channels/webhooks/meta` }
        : null,
    };
  }
}

@ApiTags("whatsapp-webhooks")
@Controller("webhooks/meta/whatsapp")
export class MetaWebhookController {
  private readonly logger = new Logger(MetaWebhookController.name);

  constructor(private readonly whatsapp: WhatsAppService) {}

  @Get()
  @Public() // Meta checks hub.verify_token in verifyChallenge
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
    @Res() res: Response,
  ) {
    return sendChallenge(res, this.whatsapp.verifyChallenge(mode, token, challenge));
  }

  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 1000, limit: 50 } })
  async handle(
    @Headers("x-hub-signature-256") signature: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const raw = (req as any).rawBody as Buffer | undefined;
    const text = raw ? raw.toString("utf8") : JSON.stringify(body ?? {});
    if (!this.whatsapp.verifyWebhook(text, signature)) {
      return res.status(HttpStatus.FORBIDDEN).send("Bad signature");
    }
    try {
      await this.whatsapp.routeWebhook(body);
    } catch (err: any) {
      // A "BAJA" that could not even be written down must not be lost:
      // a 500 makes Meta deliver the event again (the receptionist and the
      // statuses handle a repeat once).
      if (err instanceof OptOutNotRecordedError) {
        this.logger.error(err.message);
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ received: false });
      }
      this.logger.error(`Meta webhook handler error: ${err?.message}`);
    }
    return res.json({ received: true });
  }
}
/**
 * The answer to Meta's verification GET: the challenge as plain text (with
 * nosniff, so no browser renders it as a page) only when it was accepted;
 * 403 otherwise. Used by /webhooks/meta/whatsapp and /channels/webhooks/meta.
 */
export function sendChallenge(res: Response, value: string | null) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type("text/plain");
  if (value === null) return res.status(HttpStatus.FORBIDDEN).send("Forbidden");
  return res.status(HttpStatus.OK).send(value);
}
