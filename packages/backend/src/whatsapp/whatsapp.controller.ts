import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  Query,
  Headers,
  Res,
  BadRequestException,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiBearerAuth } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { createHmac, randomBytes } from "crypto";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { FeatureGuard } from "../common/guards/feature.guard";
import { Feature } from "../common/decorators/feature.decorator";
import { Public } from "../auth/decorators/public.decorator";
import { ConfigService } from "@nestjs/config";
import { WhatsAppService } from "./whatsapp.service";

interface AuthedRequest extends Request {
  user: { id: string; tenantId: string; role: string };
}

@ApiTags("whatsapp")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, FeatureGuard)
@Controller("whatsapp")
export class WhatsAppController {
  constructor(
    private readonly whatsapp: WhatsAppService,
    private config: ConfigService,
  ) {}

  @Get("connect/start")
  start(@Req() req: AuthedRequest, @Res() res: Response) {
    const state = this.signState(req.user.tenantId);
    const url = this.whatsapp.buildConnectUrl(state);
    return res.json({ url, state });
  }

  @Get("connect/callback")
  @Public()
  async callback(@Query("code") code: string, @Query("state") state: string) {
    if (!code || !state) throw new BadRequestException("code and state required");
    const tenantId = this.verifyState(state);
    return this.whatsapp.completeOAuth(tenantId, code);
  }

  @Post("connect/manual")
  async manual(
    @Req() req: AuthedRequest,
    @Body() body: {
      accessToken: string;
      wabaId: string;
      phoneNumberId: string;
      displayPhone: string;
      displayName?: string;
    },
  ) {
    return this.whatsapp.manualConnect(req.user.tenantId, body);
  }

  @Get("connection")
  async getConnection(@Req() req: AuthedRequest) {
    return this.whatsapp.getConnection(req.user.tenantId);
  }

  @Delete("connection")
  async disconnect(@Req() req: AuthedRequest) {
    return this.whatsapp.disconnect(req.user.tenantId);
  }

  @Get("templates")
  async templates(@Req() req: AuthedRequest) {
    return this.whatsapp.listTemplates(req.user.tenantId);
  }

  @Post("campaigns")
  @Roles("owner", "admin")
  @Feature("whatsapp_notifications")
  async createCampaign(
    @Req() req: AuthedRequest,
    @Body() body: {
      name: string;
      templateId: string;
      templateVars?: Record<string, string>;
      segmentFilter?: Record<string, any>;
      audience: string[];
      scheduledAt?: string;
    },
  ) {
    return this.whatsapp.createCampaign(req.user.tenantId, {
      ...body,
      templateVars: body.templateVars ?? {},
      segmentFilter: body.segmentFilter ?? {},
      scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
    });
  }

  @Post("campaigns/:id/send")
  @Roles("owner", "admin")
  @Feature("whatsapp_notifications")
  async sendCampaign(@Param("id") id: string) {
    return this.whatsapp.sendCampaign(id);
  }

  @Get("campaigns/:id/report")
  @Roles("owner", "admin", "staff")
  @Feature("whatsapp_notifications")
  report(@Param("id") id: string) {
    return this.whatsapp.report(id);
  }

  private signState(tenantId: string): string {
    const nonce = randomBytes(8).toString("hex");
    const secret = this.config.get<string>("JWT_SECRET") || "kira-dev";
    const sig = createHmac("sha256", secret)
      .update(`${tenantId}.${nonce}`)
      .digest("hex")
      .slice(0, 24);
    return `${tenantId}.${nonce}.${sig}`;
  }

  private verifyState(state: string): string {
    const parts = state.split(".");
    if (parts.length !== 3) throw new BadRequestException("Invalid state");
    const [tenantId, nonce, sig] = parts;
    const secret = this.config.get<string>("JWT_SECRET") || "kira-dev";
    const expected = createHmac("sha256", secret)
      .update(`${tenantId}.${nonce}`)
      .digest("hex")
      .slice(0, 24);
    if (expected !== sig) throw new BadRequestException("Bad state signature");
    return tenantId;
  }
}

@ApiTags("whatsapp-webhooks")
@Controller("webhooks/meta/whatsapp")
export class MetaWebhookController {
  constructor(
    private readonly whatsapp: WhatsAppService,
    private config: ConfigService,
  ) {}

  @Get()
  verify(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") token: string,
    @Query("hub.challenge") challenge: string,
    @Res() res: Response,
  ) {
    const value = this.whatsapp.verifyChallenge(mode, token, challenge);
    if (value === null) {
      return res.status(HttpStatus.FORBIDDEN).send("Forbidden");
    }
    return res.status(HttpStatus.OK).send(value);
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
      console.error("Meta webhook handler error:", err.message);
    }
    return res.json({ received: true });
  }
}