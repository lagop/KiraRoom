import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { MetaCloudApiClient } from "./meta-cloud-api.client";
import { ConfigService } from "@nestjs/config";
import { createHmac, timingSafeEqual } from "crypto";
import { WhatsAppRecipientStatus } from "@prisma/client";
import { ConsentService } from "../consent/consent.service";
import { phoneKey } from "../common/phone";
import { WhatsAppReceptionistService } from "./whatsapp-receptionist.service";
import { WhatsAppTemplateService } from "./whatsapp-template.service";

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
    private readonly consent: ConsentService,
    private readonly receptionist: WhatsAppReceptionistService,
    private readonly templates: WhatsAppTemplateService,
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
    // Ask Meta to review the reminder template now: approval takes from
    // minutes to a day, and reminders need it. Not awaited.
    void this.templates
      .submitStandardTemplates(tenantId)
      .catch((err) => this.logger.warn(`Template submission for tenant ${tenantId} failed: ${(err as Error).message}`));
    return conn;
  }

  /** Resubmits the standard templates (e.g. after one was rejected and fixed). */
  submitStandardTemplates(tenantId: string) {
    return this.templates.submitStandardTemplates(tenantId);
  }

  standardTemplateStatus(tenantId: string) {
    return this.templates.standardStatus(tenantId);
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
    // Inbound messages: opt-out words, and everything else to the receptionist.
    const messages = value.messages ?? [];
    const names = new Map<string, string>(
      (value.contacts ?? []).map((c: any) => [c?.wa_id, c?.profile?.name] as [string, string]),
    );
    for (const m of messages) {
      const body = (m.text?.body ?? "").toString().trim().toLowerCase();
      const from = m.from;
      if (!from) continue;
      // "cancelar" used to opt the person out of campaigns. With the
      // receptionist answering, it is far more likely to be about an
      // appointment, so only the explicit words unsubscribe.
      const isStop = body === "stop" || body === "unsubscribe" || body === "baja";
      if (!isStop) {
        // Not awaited: the webhook answers Meta at once; see WhatsAppReceptionistService.
        void this.receptionist.enqueue(tenantId, {
          id: m.id,
          from,
          type: m.type,
          text: m.text?.body,
          profileName: names.get(from),
        });
        continue;
      }
      if (isStop) await this.optOut(tenantId, from);
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

  /**
   * BAJA / STOP from a number: the clients with that number stop getting
   * WhatsApp promotions (consent withdrawn, as the client's own act) and any
   * campaign message still waiting for them is not sent. Matched on the last
   * nine digits: Meta sends "34600111222", the client file may say
   * "600 111 222" (the old lookup by substring never matched those).
   */
  private async optOut(tenantId: string, from: string): Promise<void> {
    const key = phoneKey(from);
    if (key.length !== 9) return;
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM clients
      WHERE "tenantId" = ${tenantId}
        AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 9) = ${key}`;
    for (const { id } of rows) {
      try {
        await this.consent.recordMarketingChoice({ tenantId, clientId: id, accepts: false, channel: "whatsapp" });
      } catch (err) {
        this.logger.warn(`WhatsApp opt-out of client ${id} not recorded: ${(err as Error).message}`);
      }
      await this.prisma.whatsAppCampaignRecipient.updateMany({
        where: { clientId: id, status: WhatsAppRecipientStatus.pending },
        data: { status: WhatsAppRecipientStatus.opted_out },
      });
    }
    this.logger.log(`WhatsApp opt-out for tenant ${tenantId}: ${rows.length} client(s)`);
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