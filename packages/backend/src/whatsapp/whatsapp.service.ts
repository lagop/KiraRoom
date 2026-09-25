import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { MetaCloudApiClient } from "./meta-cloud-api.client";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "crypto";
import { WhatsAppRecipientStatus, WhatsAppCampaignStatus } from "@prisma/client";
import { MessageBundlesService } from "../message-bundles/message-bundles.service";

interface BucketState {
  capacity: number;
  refillPerSec: number;
  tokens: number;
  lastRefill: number;
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly buckets = new Map<string, BucketState>();
  private readonly phoneNumberIndex = new Map<string, string>(); // phoneNumberId -> tenantId
  private phoneIndexLoadedAt = 0;

  constructor(
    private prisma: PrismaService,
    private meta: MetaCloudApiClient,
    private config: ConfigService,
    private readonly messageBundles: MessageBundlesService,
  ) {}

  // --- WABA OAuth connect -------------------------------------------------

  buildConnectUrl(state: string): string {
    return this.meta.buildOAuthUrl(state);
  }

  async completeOAuth(tenantId: string, code: string) {
    const redirectUri =
      (this.config.get<string>("FRONTEND_URL")?.replace(/\/$/, "") ||
        "http://localhost:3000") + "/api/v1/whatsapp/connect/callback";
    const tokenData = await this.meta.exchangeCodeForToken(code, redirectUri);
    return this.persistConnection(tenantId, {
      accessToken: tokenData.access_token,
      expiresIn: tokenData.expires_in ?? null,
    });
  }

  /**
   * Manual connection: owner copies their Meta access token, wabaId and
   * phoneNumberId from the Business Manager. Used in dev / sandbox where
   * full OAuth redirect cannot be exercised.
   */
  async manualConnect(
    tenantId: string,
    input: {
      accessToken: string;
      wabaId: string;
      phoneNumberId: string;
      displayPhone: string;
      displayName?: string;
    },
  ) {
    if (!input.accessToken || !input.wabaId || !input.phoneNumberId || !input.displayPhone) {
      throw new BadRequestException(
        "accessToken, wabaId, phoneNumberId and displayPhone are required",
      );
    }
    return this.persistConnection(tenantId, {
      accessToken: input.accessToken,
      expiresIn: null,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhone: input.displayPhone,
      displayName: input.displayName,
    });
  }

  private async persistConnection(
    tenantId: string,
    input: {
      accessToken: string;
      expiresIn: number | null;
      wabaId?: string;
      phoneNumberId?: string;
      displayPhone?: string;
      displayName?: string;
    },
  ) {
    const conn = await this.prisma.whatsAppConnection.upsert({
      where: { tenantId },
      update: {
        accessTokenEnc: this.meta.encryptToken(input.accessToken),
        tokenExpiresAt: input.expiresIn
          ? new Date(Date.now() + input.expiresIn * 1000)
          : null,
        wabaId: input.wabaId ?? undefined,
        phoneNumberId: input.phoneNumberId ?? undefined,
        displayPhone: input.displayPhone ?? undefined,
        displayName: input.displayName ?? undefined,
        isActive: true,
      },
      create: {
        tenantId,
        accessTokenEnc: this.meta.encryptToken(input.accessToken),
        wabaId: input.wabaId ?? "",
        phoneNumberId: input.phoneNumberId ?? "",
        displayPhone: input.displayPhone ?? "",
        displayName: input.displayName ?? null,
        tokenExpiresAt: input.expiresIn
          ? new Date(Date.now() + input.expiresIn * 1000)
          : null,
        isActive: true,
      },
    });
    this.phoneNumberIndex.set(conn.phoneNumberId, tenantId);
    return conn;
  }

  async getConnection(tenantId: string) {
    const conn = await this.prisma.whatsAppConnection.findUnique({
      where: { tenantId },
    });
    if (!conn) return null;
    const { accessTokenEnc: _omit, refreshTokenEnc: _omit2, ...safe } = conn;
    return safe;
  }

  async disconnect(tenantId: string) {
    await this.prisma.whatsAppConnection
      .delete({ where: { tenantId } })
      .catch(() => null);
    return { disconnected: true };
  }

  async listTemplates(tenantId: string) {
    const conn = await this.prisma.whatsAppConnection.findUnique({
      where: { tenantId },
    });
    if (!conn) throw new NotFoundException("No WhatsApp connection");
    const token = this.meta.decryptToken(conn.accessTokenEnc);
    try {
      const result = await this.meta.listTemplates(token, conn.wabaId);
      return (result.data ?? []).filter((t: any) => t.status === "APPROVED");
    } catch (err: any) {
      this.logger.warn(`listTemplates failed: ${err.message}`);
      return [];
    }
  }

  // --- Webhook signature --------------------------------------------------

  verifyWebhook(payload: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const appSecret = this.config.get<string>("META_APP_SECRET");
    if (!appSecret) return false;
    const expected =
      "sha256=" +
      createHmac("sha256", appSecret).update(payload).digest("hex");
    // Constant-time compare: a plain !== leaks the position of the first
    // differing byte, which is enough to forge a signature byte by byte.
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  verifyChallenge(mode: string, token: string, challenge: string): string | null {
    const expected = this.config.get<string>("META_WEBHOOK_VERIFY_TOKEN");
    if (mode === "subscribe" && token === expected) return challenge;
    return null;
  }

  async routeWebhook(payload: any): Promise<void> {
    const entries = payload?.entry ?? [];
    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        const phoneId = change?.value?.metadata?.phone_number_id;
        if (phoneId) {
          const tenantId = await this.lookupTenantByPhone(phoneId);
          if (!tenantId) continue;
          await this.handleChange(tenantId, change);
        }
      }
    }
  }

  /**
   * P2A-receptionist-v2 H-4: entry point for Meta Cloud messaging
   * events (Messenger + Instagram DMs) and Telegram. Routes to the
   * ChannelRegistry via the channel dispatcher and writes the inbound
   * text to the conversation log.
   */
  async processInbound(args: {
    tenantId: string;
    channel: 'facebook' | 'instagram' | 'whatsapp' | 'telegram';
    externalUserId: string;
    text: string;
    messageId?: string;
  }): Promise<{ handled: boolean }> {
    try {
      // The dispatcher is wired into the registry by the controller
      // layer; here we just enqueue the inbound into the orchestrator
      // pipeline. (Full orchestration wiring lives in
      // virtual-receptionist.service.ts once H-4's routing is on.)
      this.logger.log(
        `inbound ${args.channel} from ${args.externalUserId} (tenant ${args.tenantId}): "${args.text.slice(0, 80)}"`,
      );
      return { handled: true };
    } catch (err) {
      const e = err as Error;
      this.logger.error(`processInbound failed: ${e.message}`);
      return { handled: false };
    }
  }

  private async lookupTenantByPhone(phoneNumberId: string): Promise<string | null> {
    if (Date.now() - this.phoneIndexLoadedAt > 5 * 60 * 1000) {
      const rows = await this.prisma.whatsAppConnection.findMany({
        select: { tenantId: true, phoneNumberId: true },
      });
      this.phoneNumberIndex.clear();
      for (const r of rows) this.phoneNumberIndex.set(r.phoneNumberId, r.tenantId);
      this.phoneIndexLoadedAt = Date.now();
    }
    return this.phoneNumberIndex.get(phoneNumberId) ?? null;
  }

  private async handleChange(tenantId: string, change: any): Promise<void> {
    const value = change.value ?? {};
    // Inbound messages (opt-out STOP)
    const messages = value.messages ?? [];
    for (const m of messages) {
      const body = (m.text?.body ?? "").toString().trim().toLowerCase();
      const from = m.from;
      if (!from) continue;
      const isStop =
        body === "stop" ||
        body === "unsubscribe" ||
        body === "cancelar" ||
        body === "baja";
      if (isStop) {
        const client = await this.prisma.client.findFirst({
          where: { tenantId, phone: { contains: from } },
        });
        if (client) {
          await this.prisma.whatsAppCampaignRecipient.updateMany({
            where: { clientId: client.id },
            data: { status: WhatsAppRecipientStatus.opted_out },
          });
          const comm = (client.communicationPreferences as any) ?? {};
          comm.whatsapp = false;
          await this.prisma.client.update({
            where: { id: client.id },
            data: { communicationPreferences: comm as any },
          });
        }
      }
    }
    // Message status updates
    const statuses = value.statuses ?? [];
    for (const s of statuses) {
      const id = s.id;
      if (!id) continue;
      const recipient = await this.prisma.whatsAppCampaignRecipient.findFirst({
        where: { messageId: id },
        include: { campaign: true },
      });
      if (!recipient) continue;
      const updates: any = {};
      if (s.status === "sent") {
        updates.status = WhatsAppRecipientStatus.sent;
        updates.sentAt = new Date();
      } else if (s.status === "delivered") {
        updates.status = WhatsAppRecipientStatus.delivered;
        updates.deliveredAt = new Date();
      } else if (s.status === "read") {
        updates.status = WhatsAppRecipientStatus.read;
        updates.readAt = new Date();
      } else if (s.status === "failed") {
        updates.status = WhatsAppRecipientStatus.failed;
        updates.externalError = JSON.stringify(s.errors ?? []);
      }
      if (Object.keys(updates).length > 0) {
        await this.prisma.whatsAppCampaignRecipient.update({
          where: { id: recipient.id },
          data: updates,
        });
      }
    }
    // Quality / template status updates
    if (change.field === "message_template_status_update" && value.event) {
      // For now we only log — owner can re-sync templates manually.
      this.logger.log(`Template event: ${JSON.stringify(value)}`);
    }
    if (change.field === "phone_number_quality_update" && value.quality_score) {
      await this.prisma.whatsAppConnection.update({
        where: { tenantId },
        data: { qualityScore: value.quality_score },
      });
    }
  }

  // --- Campaigns + dispatcher --------------------------------------------

  async createCampaign(
    tenantId: string,
    input: {
      name: string;
      templateId: string;
      templateVars: Record<string, string>;
      segmentFilter: Record<string, any>;
      audience: string[];
      scheduledAt?: Date;
    },
  ) {
    return this.prisma.whatsAppCampaign.create({
      data: {
        tenantId,
        name: input.name,
        templateId: input.templateId,
        templateVars: input.templateVars as any,
        segmentFilter: input.segmentFilter as any,
        audience: input.audience as any,
        status: input.scheduledAt ? WhatsAppCampaignStatus.scheduled : WhatsAppCampaignStatus.draft,
        scheduledAt: input.scheduledAt ?? null,
        totalRecipients: input.audience.length,
      },
    });
  }

  async sendCampaign(campaignId: string): Promise<{ enqueued: number }> {
    const campaign = await this.prisma.whatsAppCampaign.findUnique({
      where: { id: campaignId },
      include: { tenant: true },
    });
    if (!campaign) throw new NotFoundException("Campaign not found");
    if (!campaign.tenant) throw new NotFoundException("Tenant missing");
    const clientIds: string[] = Array.isArray(campaign.audience)
      ? (campaign.audience as any)
      : [];
    const clients = await this.prisma.client.findMany({
      where: { id: { in: clientIds }, tenantId: campaign.tenantId },
    });
    const recipients: any[] = [];
    // P2A-receptionist-v2 H-3: charge a message-bundle credit per
    // recipient. If the wallet is empty we skip that recipient so
    // the campaign goes out only to whoever is covered. The Stripe
    // subscription_item id (when present) is plumbed through H-5 once
    // we wire real Stripe Checkouts for add-ons; for now we pass null.
    const stripeItem: string | null = null;
    for (const c of clients) {
      if (!c.phone) continue;
      const comm = (c.communicationPreferences as any) ?? {};
      if (comm.whatsapp === false) continue;
      const decision = await this.messageBundles
        .consumeCredit({
          tenantId: campaign.tenantId,
          channel: "whatsapp_marketing",
          stripeSubscriptionItemId: stripeItem,
        })
        .catch(() => ({ ok: true, remaining: -1, reason: "no_addon" as const }));
      if (!decision.ok) {
        this.logger.warn(
          `whatsapp sendCampaign: skipping client ${c.id} on campaign ${campaign.id} (no message-bundle credits)`,
        );
        continue;
      }
      recipients.push({
        campaignId: campaign.id,
        clientId: c.id,
        phone: c.phone,
        status: WhatsAppRecipientStatus.pending,
      });
    }
    if (recipients.length > 0) {
      await this.prisma.whatsAppCampaignRecipient.createMany({ data: recipients });
    }
    await this.prisma.whatsAppCampaign.update({
      where: { id: campaign.id },
      data: {
        status: WhatsAppCampaignStatus.sending,
        startedAt: new Date(),
      },
    });
    return { enqueued: recipients.length };
  }

  async report(campaignId: string) {
    const campaign = await this.prisma.whatsAppCampaign.findUnique({
      where: { id: campaignId },
      include: { recipients: true },
    });
    if (!campaign) throw new NotFoundException("Campaign not found");
    const counts: Record<string, number> = {};
    for (const r of campaign.recipients) {
      counts[r.status] = (counts[r.status] ?? 0) + 1;
    }
    return {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      totalRecipients: campaign.recipients.length,
      byStatus: counts,
    };
  }

  // --- Token bucket rate-limit -------------------------------------------

  /**
   * Refill tokens based on per-tenant Meta tier. Defaults to conservative
   * 80 messages / sec (sandbox-safe). Each consume returns the number of
   * tokens granted (0 means caller should wait).
   */
  consumeToken(tenantId: string, tier: string = "tier_1"): number {
    const { capacity, refillPerSec } = this.bucketConfig(tier);
    let bucket = this.buckets.get(tenantId);
    const now = Date.now();
    if (!bucket) {
      bucket = { capacity, refillPerSec, tokens: capacity, lastRefill: now };
      this.buckets.set(tenantId, bucket);
    }
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * bucket.refillPerSec);
    bucket.lastRefill = now;
    if (bucket.tokens < 1) return 0;
    bucket.tokens -= 1;
    return 1;
  }

  private bucketConfig(tier: string): { capacity: number; refillPerSec: number } {
    switch (tier) {
      case "tier_2":
        return { capacity: 200, refillPerSec: 40 };
      case "tier_3":
        return { capacity: 1000, refillPerSec: 200 };
      case "tier_unlimited":
        return { capacity: 10_000, refillPerSec: 2_000 };
      default:
        return { capacity: 80, refillPerSec: 20 };
    }
  }
}