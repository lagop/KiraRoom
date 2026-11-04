import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import type { WhatsAppConnection, WhatsAppOptOut } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { runUnscoped } from "../common/tenancy/tenant.context";
import { GraphCall, MetaCloudApiClient } from "./meta-cloud-api.client";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { WhatsAppCampaignStatus, WhatsAppRecipientStatus } from "@prisma/client";
import { accountLevelReason } from "./campaigns/meta-account-errors";
import { ChannelHealthService, isWhatsAppAuthError } from "../channel-health/channel-health.service";
import { whatsAppInbound } from "./inbound-kinds";
import { ConsentService } from "../consent/consent.service";
import { phoneKey } from "../common/phone";
import { optOutIntent } from "./opt-out-words";
import { WhatsAppReceptionistService } from "./whatsapp-receptionist.service";
import { WhatsAppTemplateService } from "./whatsapp-template.service";
import { MonitoredJob } from "../common/ops-alerts/ops-alert-sink";

/** A campaign message's progress, in order. */
const DELIVERY_STEPS: WhatsAppRecipientStatus[] = [
  WhatsAppRecipientStatus.pending,
  WhatsAppRecipientStatus.sent,
  WhatsAppRecipientStatus.delivered,
  WhatsAppRecipientStatus.read,
];

/** Meta's status timestamp (Unix seconds, as a string), or now. */
function metaTime(timestamp: unknown): Date {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

/**
 * A connection as the panel sees it: never the access or refresh token, not
 * even encrypted. Every endpoint that answers with a connection goes through
 * this (connect, check, getConnection).
 */
export function safeWhatsAppConnection(conn: WhatsAppConnection) {
  const { accessTokenEnc: _token, refreshTokenEnc: _refresh, ...safe } = conn;
  return {
    ...safe,
    /** Why Meta refuses the token, in Spanish, while authErrorAt is set. */
    accessProblem: conn.authErrorAt ? accountLevelReason(conn.authError ?? "meta_190") : null,
  };
}

/** Shown when a phone-number id is already another salon's. */
export const WHATSAPP_NUMBER_TAKEN =
  "Ese número de WhatsApp ya está conectado a otro salón. Si es tuyo, escríbenos a soporte para revisarlo.";

/** Why a manual connection was refused, in Spanish (M4: checked with Meta before saving). */
export const CONNECT_ERRORS = {
  tokenInvalid:
    "Meta no acepta este token de acceso: ha caducado o no es válido. Copia un token permanente (de un usuario del sistema) desde el Administrador comercial de Meta.",
  tokenPermissions:
    "El token no tiene permiso sobre esta cuenta de WhatsApp Business. Al crearlo, dale los permisos whatsapp_business_management y whatsapp_business_messaging y acceso a la cuenta.",
  phoneNotFound:
    "Meta no encuentra ese identificador de número (Phone number ID). Cópialo de la página «Configuración de la API» de WhatsApp en Meta.",
  wabaNotFound:
    "Meta no encuentra esa cuenta de WhatsApp Business (WABA ID), o el token no tiene acceso a ella.",
  numberNotInWaba: "Ese número no pertenece a esa cuenta de WhatsApp Business. Revisa los dos identificadores.",
  unreachable: "No se ha podido comprobar la conexión con Meta. Vuelve a intentarlo en unos minutos.",
};

export function tokenExpiresSoon(date: Date): string {
  return `Este token caduca el ${date.toLocaleDateString("es-ES", { timeZone: "Europe/Madrid" })}: es un token temporal y WhatsApp dejaría de funcionar ese día. Crea un token permanente de un usuario del sistema en el Administrador comercial de Meta.`;
}

/** The webhook subscription could not be made or confirmed (M1). */
export const WEBHOOK_OTHER_APP =
  "Meta envía los mensajes de esta cuenta a otra app (la del token), no a la de KiraRoom: la recepcionista no los recibirá ni se registrarán las respuestas «BAJA». Escríbenos a soporte para completar la conexión.";
export function webhookRefused(metaMessage: string): string {
  return `Meta no ha permitido que KiraRoom reciba los mensajes de esta cuenta: ${metaMessage}`;
}

/** A token shorter-lived than this is refused: it is the 24-hour one from "API Setup". */
const MIN_TOKEN_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** The value in .env.example, public: a verify token equal to it proves nothing. */
export const EXAMPLE_VERIFY_TOKEN = "change_me_webhook_verify_token";

/** A configured verify token that is not empty and not a placeholder. */
export function verifyTokenUsable(value: string | undefined | null): value is string {
  if (!value || !value.trim()) return false;
  return value !== EXAMPLE_VERIFY_TOKEN && !/^change_me/i.test(value.trim());
}

/** Meta's hub.challenge is a number; nothing else is echoed. */
const CHALLENGE = /^[A-Za-z0-9_-]{1,128}$/;

/** A "BAJA" that could not be written down: the webhook answers 500 so Meta retries it. */
/** The reply to a BAJA (D23): promotions stop, appointment notices do not. */
export function optOutConfirmation(salonName?: string | null): string {
  const salon = salonName?.trim() || "este salón";
  return `Hecho. No te enviaremos más promociones de ${salon}. Los avisos de tus citas seguirán llegando.`;
}

/** A free-text reply is only allowed within 24 h of the person's message; a margin is kept. */
const OPT_OUT_CONFIRM_WINDOW_MS = 23 * 60 * 60 * 1000;

/**
 * Shown to the salon when KiraRoom's own Meta app is not set up on the
 * server (META_APP_ID / META_APP_SECRET): sending works with the salon's
 * token, but every webhook from Meta is refused (its signature cannot be
 * checked), so nothing is received.
 */
export const RECEIVING_UNAVAILABLE =
  "KiraRoom todavía no puede recibir mensajes de WhatsApp: falta configurar la app de Meta de la plataforma. Los recordatorios y avisos sí salen desde tu número, pero la recepcionista no contestará y las respuestas «BAJA» no se registrarán hasta que lo activemos. Escríbenos a soporte si lo necesitas ya.";

/** An event from Meta counts for the reception test this long before the test started (throttle below). */
const INBOUND_TOUCH_MS = 60 * 1000;

export class OptOutNotRecordedError extends Error {}

/** A connection Meta refused: Spanish 400, with Meta's error code when there was one. */
class MetaCheckError extends BadRequestException {
  constructor(message: string, readonly metaCode?: number) {
    super(message);
  }
}

@Injectable()
export class WhatsAppService implements OnModuleInit {
  private readonly logger = new Logger(WhatsAppService.name);
  // When each salon's lastInboundAt was last written, so a busy number does
  // not write it on every event.
  private readonly inboundTouched = new Map<string, number>();
  // phoneNumberId -> tenantId, or null when more than one salon holds the
  // number (connected before that was refused): such a number routes nowhere.
  private readonly phoneNumberIndex = new Map<string, string | null>();
  private phoneIndexLoadedAt = 0;

  constructor(
    private prisma: PrismaService,
    private meta: MetaCloudApiClient,
    private config: ConfigService,
    private readonly consent: ConsentService,
    private readonly receptionist: WhatsAppReceptionistService,
    private readonly templates: WhatsAppTemplateService,
    @Optional() private readonly health?: ChannelHealthService,
  ) {}

  /** Says at boot when Meta's webhook verification is going to be refused (M3). The value is never logged. */
  onModuleInit(): void {
    if (!verifyTokenUsable(this.config.get<string>("META_WEBHOOK_VERIFY_TOKEN"))) {
      this.logger.error(
        "META_WEBHOOK_VERIFY_TOKEN is missing or still the example value: Meta's webhook verification is refused until it is set to a random secret.",
      );
    }
  }

  // The WhatsApp OAuth ("Conectar con Meta") was removed: its routes answer
  // 410 (whatsapp.controller.ts) and the embedded signup is a pending
  // decision. The manual connection below is the only way in.

  /**
   * Manual connection: the owner copies a permanent access token, the WABA
   * id and the phone-number id from Meta's Business Manager.
   *
   * It used to save them without asking Meta anything and answer
   * "Conectado": a 24-hour token from "API Setup" stopped everything the
   * next day, a mistyped id stayed "Conectado", and nobody subscribed the
   * account to KiraRoom's webhook, so no message ever arrived. Now the token
   * and both ids are checked with Meta first (the display number is Meta's),
   * then the account is subscribed to the webhook and the result kept.
   */
  async manualConnect(
    tenantId: string,
    input: {
      accessToken: string;
      wabaId: string;
      phoneNumberId: string;
      displayPhone?: string;
      displayName?: string;
    },
  ) {
    if (!input.accessToken || !input.wabaId || !input.phoneNumberId) {
      throw new BadRequestException("accessToken, wabaId and phoneNumberId are required");
    }
    const token = input.accessToken.trim();
    const checked = await this.checkWithMeta(token, input.wabaId, input.phoneNumberId);
    return this.persistConnection(tenantId, {
      accessToken: token,
      tokenExpiresAt: checked.expiresAt,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhone: checked.displayPhone || input.displayPhone || "",
      displayName: input.displayName?.trim() || checked.verifiedName,
      qualityScore: checked.quality,
    });
  }

  /**
   * "Comprobar de nuevo": the stored token and number checked with Meta
   * again. Clears the "access refused" mark when Meta accepts them, and
   * subscribes the account to the webhook again.
   */
  async checkConnection(tenantId: string) {
    const conn = await this.prisma.whatsAppConnection.findUnique({ where: { tenantId } });
    if (!conn) throw new NotFoundException("No WhatsApp connection");
    const token = this.meta.decryptToken(conn.accessTokenEnc);
    let checked: Awaited<ReturnType<WhatsAppService["checkWithMeta"]>>;
    try {
      checked = await this.checkWithMeta(token, conn.wabaId, conn.phoneNumberId);
    } catch (err) {
      if (err instanceof MetaCheckError && err.metaCode !== undefined) {
        await this.health?.whatsAppError(tenantId, err.metaCode);
      }
      throw err;
    }
    await this.prisma.whatsAppConnection.update({
      where: { tenantId },
      data: {
        authErrorAt: null,
        authError: null,
        attentionNotifiedAt: null,
        ...(checked.displayPhone ? { displayPhone: checked.displayPhone } : {}),
        ...(checked.quality ? { qualityScore: checked.quality } : {}),
        tokenExpiresAt: checked.expiresAt,
      },
    });
    return safeWhatsAppConnection(await this.subscribeWebhook(tenantId, token, conn.wabaId));
  }

  /** Asks Meta about the token, the number and the account; throws a Spanish 400 when any is wrong. */
  private async checkWithMeta(
    token: string,
    wabaId: string,
    phoneNumberId: string,
  ): Promise<{ displayPhone?: string; verifiedName?: string; quality?: string; expiresAt: Date | null }> {
    const phone = await this.meta.getPhoneNumber(token, phoneNumberId);
    if (!phone.ok) throw this.checkError(phone.error, "phone");
    const numbers = await this.meta.listPhoneNumbers(token, wabaId);
    if (!numbers.ok) throw this.checkError(numbers.error, "waba");
    if (!(numbers.data?.data ?? []).some((n) => String(n?.id) === String(phoneNumberId))) {
      throw new MetaCheckError(CONNECT_ERRORS.numberNotInWaba);
    }
    // When it expires (and whether it is valid), with KiraRoom's app token.
    // Best effort: without the app configured, or if Meta does not answer
    // for a token of another app, the connection goes on without a date.
    let expiresAt: Date | null = null;
    const debug = await this.meta.debugToken(token);
    if (debug?.ok) {
      const info = debug.data?.data ?? {};
      if (info.is_valid === false) throw new MetaCheckError(CONNECT_ERRORS.tokenInvalid, 190);
      if (info.expires_at && info.expires_at > 0) {
        expiresAt = new Date(info.expires_at * 1000);
        if (expiresAt.getTime() - Date.now() < MIN_TOKEN_LIFE_MS) throw new MetaCheckError(tokenExpiresSoon(expiresAt));
      }
    }
    const quality = phone.data?.quality_rating;
    return {
      displayPhone: phone.data?.display_phone_number,
      verifiedName: phone.data?.verified_name,
      quality: quality === "GREEN" || quality === "YELLOW" || quality === "RED" ? quality : undefined,
      expiresAt,
    };
  }

  private checkError(error: GraphCall<unknown>["error"], what: "phone" | "waba"): MetaCheckError {
    if (!error || error.network) return new MetaCheckError(CONNECT_ERRORS.unreachable);
    if (error.code === 190) return new MetaCheckError(CONNECT_ERRORS.tokenInvalid, 190);
    if (isWhatsAppAuthError(error.code)) return new MetaCheckError(CONNECT_ERRORS.tokenPermissions, error.code);
    if (error.code === 100 || error.code === 803) {
      return new MetaCheckError(what === "phone" ? CONNECT_ERRORS.phoneNotFound : CONNECT_ERRORS.wabaNotFound);
    }
    return new MetaCheckError(`Meta no aceptó los datos: ${error.message}`);
  }

  /**
   * Subscribes the account to the webhook (POST /{waba}/subscribed_apps)
   * and keeps the result: subscribed, or why not. With KiraRoom's app id
   * configured the list of subscribed apps is read back: a token from the
   * salon's own app subscribes that app, whose deliveries never reach
   * KiraRoom, and the panel must say so instead of promising answers.
   */
  private async subscribeWebhook(tenantId: string, token: string, wabaId: string): Promise<WhatsAppConnection> {
    let error: string | null = null;
    const sub = await this.meta.subscribeApp(token, wabaId);
    if (!sub.ok) {
      error = sub.error?.network ? CONNECT_ERRORS.unreachable : webhookRefused(sub.error?.message ?? "error desconocido");
      if (!sub.error?.network) await this.health?.whatsAppError(tenantId, sub.error?.code);
    } else {
      const appId = this.config.get<string>("META_APP_ID");
      if (appId) {
        const apps = await this.meta.listSubscribedApps(token, wabaId);
        if (apps.ok && !(apps.data?.data ?? []).some((a) => String(a?.whatsapp_business_api_data?.id) === String(appId))) {
          error = WEBHOOK_OTHER_APP;
        }
      }
    }
    if (error) this.logger.warn(`WhatsApp webhook of tenant ${tenantId} not active: ${error}`);
    return this.prisma.whatsAppConnection.update({
      where: { tenantId },
      data: { webhookSubscribedAt: error ? null : new Date(), webhookError: error },
    });
  }

  private async persistConnection(
    tenantId: string,
    input: {
      accessToken: string;
      tokenExpiresAt: Date | null;
      wabaId: string;
      phoneNumberId: string;
      displayPhone: string;
      displayName?: string;
      qualityScore?: string;
    },
  ) {
    // One salon per WhatsApp number: inbound messages are routed by this id,
    // so a second salon entering it would receive the first one's clients.
    // Unscoped: inside the salon's request the tenant filter would hide
    // every other salon's row and the check could never match. The partial
    // unique index (migration 20261104040000) closes the race between two
    // salons connecting at the same time.
    const taken = await runUnscoped(() =>
      this.prisma.whatsAppConnection.findFirst({
        where: { phoneNumberId: input.phoneNumberId, isActive: true, tenantId: { not: tenantId } },
        select: { tenantId: true },
      }),
    );
    if (taken) {
      this.logger.warn(
        `tenant ${tenantId} tried to connect WhatsApp number ${input.phoneNumberId}, already connected to tenant ${taken.tenantId}`,
      );
      throw new ConflictException(WHATSAPP_NUMBER_TAKEN);
    }
    const fields = {
      accessTokenEnc: this.meta.encryptToken(input.accessToken),
      tokenExpiresAt: input.tokenExpiresAt,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhone: input.displayPhone,
      displayName: input.displayName ?? null,
      ...(input.qualityScore ? { qualityScore: input.qualityScore } : {}),
      isActive: true,
      // A new token: whatever Meta refused before no longer applies.
      authErrorAt: null,
      authError: null,
      attentionNotifiedAt: null,
      webhookSubscribedAt: null,
      webhookError: null,
    };
    try {
      await this.prisma.whatsAppConnection.upsert({
        where: { tenantId },
        update: fields,
        create: { tenantId, ...fields },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictException(WHATSAPP_NUMBER_TAKEN);
      }
      throw err;
    }
    // Rebuilt on the next inbound message, so a number shared with another
    // salon is seen as ambiguous instead of moving to this one.
    this.invalidatePhoneIndex();
    const conn = await this.subscribeWebhook(tenantId, input.accessToken, input.wabaId);
    // Ask Meta to review the reminder template now: approval takes from
    // minutes to a day, and reminders need it. Not awaited.
    void this.templates
      .submitStandardTemplates(tenantId)
      .catch((err) => this.logger.warn(`Template submission for tenant ${tenantId} failed: ${(err as Error).message}`));
    return safeWhatsAppConnection(conn);
  }

  private invalidatePhoneIndex() {
    this.phoneNumberIndex.clear();
    this.phoneIndexLoadedAt = 0;
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
    return safeWhatsAppConnection(conn);
  }

  /**
   * Whether KiraRoom can receive WhatsApp events at all: Meta's webhooks are
   * signed with the platform app's secret and refused without it, and the
   * subscription check needs the app id. Booleans only, never the values.
   */
  platformStatus(): { appIdSet: boolean; appSecretSet: boolean; verifyTokenSet: boolean; receiving: boolean } {
    const appIdSet = !!this.config.get<string>("META_APP_ID")?.trim();
    const appSecretSet = !!this.config.get<string>("META_APP_SECRET")?.trim();
    const verifyTokenSet = verifyTokenUsable(this.config.get<string>("META_WEBHOOK_VERIFY_TOKEN"));
    return { appIdSet, appSecretSet, verifyTokenSet, receiving: appIdSet && appSecretSet && verifyTokenSet };
  }

  /** For the salon's page: can messages be received, and if not, what to tell it. */
  setupStatus(): { receivingAvailable: boolean; receivingProblem: string | null } {
    const { receiving } = this.platformStatus();
    return { receivingAvailable: receiving, receivingProblem: receiving ? null : RECEIVING_UNAVAILABLE };
  }

  /**
   * "Probar recepción": the panel asks the salon to send a WhatsApp to its
   * number and watches lastInboundAt pass `since`. The salon's throttle is
   * reset so the next event is written at once (on this instance; another
   * one writes it within INBOUND_TOUCH_MS, which `since` allows for).
   */
  async startReceptionTest(tenantId: string) {
    const conn = await this.prisma.whatsAppConnection.findUnique({ where: { tenantId } });
    if (!conn) throw new NotFoundException("No WhatsApp connection");
    this.inboundTouched.delete(tenantId);
    const { receivingAvailable, receivingProblem } = this.setupStatus();
    const now = Date.now();
    return {
      startedAt: new Date(now).toISOString(),
      since: new Date(now - INBOUND_TOUCH_MS).toISOString(),
      receivingAvailable,
      receivingProblem,
      subscribed: !!conn.webhookSubscribedAt && !conn.webhookError,
      webhookError: conn.webhookError,
    };
  }

  async disconnect(tenantId: string) {
    await this.prisma.whatsAppConnection
      .delete({ where: { tenantId } })
      .catch(() => null);
    this.invalidatePhoneIndex();
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

  /**
   * Meta's GET when a webhook URL is configured: the challenge is echoed
   * only for "subscribe" with the right verify token. Refused outright while
   * the token is unset or still the public example value (an unset one used
   * to match a missing hub.verify_token), compared in constant time, and
   * only a plain number-like challenge is echoed (as text/plain, by the
   * controllers): it used to be returned as HTML, whatever it held.
   */
  verifyChallenge(mode: unknown, token: unknown, challenge: unknown): string | null {
    const expected = this.config.get<string>("META_WEBHOOK_VERIFY_TOKEN");
    if (!verifyTokenUsable(expected)) return null;
    if (mode !== "subscribe" || typeof token !== "string" || typeof challenge !== "string") return null;
    if (!CHALLENGE.test(challenge)) return null;
    // Hashes have the same length, so the comparison does not leak it.
    const a = createHash("sha256").update(token).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b) ? challenge : null;
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
          await this.touchInbound(tenantId);
          await this.handleChange(tenantId, change);
        }
      }
    }
  }

  /**
   * An event for this number reached KiraRoom: messages do arrive. Shown in
   * the panel ("Último mensaje recibido"), and it confirms the webhook
   * subscription. Written at most once a minute per salon (the reception
   * test waits for it); never throws.
   */
  private async touchInbound(tenantId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.inboundTouched.get(tenantId) ?? 0) < INBOUND_TOUCH_MS) return;
    this.inboundTouched.set(tenantId, now);
    try {
      await this.prisma.whatsAppConnection.updateMany({ where: { tenantId }, data: { lastInboundAt: new Date(now) } });
      await this.prisma.whatsAppConnection.updateMany({
        where: { tenantId, webhookSubscribedAt: null },
        data: { webhookSubscribedAt: new Date(now), webhookError: null },
      });
    } catch (err) {
      this.logger.warn(`lastInboundAt of tenant ${tenantId} not written: ${(err as Error).message}`);
    }
  }

  private async lookupTenantByPhone(phoneNumberId: string): Promise<string | null> {
    if (Date.now() - this.phoneIndexLoadedAt > 5 * 60 * 1000) {
      const rows = await this.prisma.whatsAppConnection.findMany({
        where: { isActive: true, phoneNumberId: { not: "" } },
        select: { tenantId: true, phoneNumberId: true },
      });
      this.phoneNumberIndex.clear();
      for (const r of rows) {
        const seen = this.phoneNumberIndex.get(r.phoneNumberId);
        // A second salon with the same number: nobody gets its messages.
        this.phoneNumberIndex.set(r.phoneNumberId, seen === undefined || seen === r.tenantId ? r.tenantId : null);
      }
      this.phoneIndexLoadedAt = Date.now();
    }
    const tenantId = this.phoneNumberIndex.get(phoneNumberId);
    if (tenantId === null) {
      this.logger.warn(`WhatsApp number ${phoneNumberId} is connected to more than one salon; message dropped`);
    }
    return tenantId ?? null;
  }

  private async handleChange(tenantId: string, change: any): Promise<void> {
    const value = change.value ?? {};
    // Inbound messages: opt-out words, and everything else to the receptionist.
    const messages = value.messages ?? [];
    const names = new Map<string, string>(
      (value.contacts ?? []).map((c: any) => [c?.wa_id, c?.profile?.name] as [string, string]),
    );
    for (const m of messages) {
      const from = m.from;
      if (!from) continue;
      // Reactions, stickers, system notices...: no answer (see inbound-kinds.ts).
      const inbound = whatsAppInbound(m);
      if (inbound.kind === "ignore") continue;
      const text = inbound.kind === "text" ? inbound.text : "";
      // "cancelar" used to opt the person out of campaigns. With the
      // receptionist answering, it is far more likely to be about an
      // appointment, so only the explicit words unsubscribe -- as words,
      // anywhere in the message, whatever the case, accents or punctuation
      // (see opt-out-words.ts).
      const stop = optOutIntent(text);
      if (stop.optOut) await this.optOut(tenantId, from, String(m.id ?? `${from}:${m.timestamp ?? ""}`));
      // A message that says more than "baja" (a question about her
      // appointment) still gets its answer.
      if (!stop.only) {
        // Not awaited: the webhook answers Meta at once; see WhatsAppReceptionistService.
        void this.receptionist.enqueue(tenantId, {
          id: m.id,
          from,
          type: inbound.kind,
          text: inbound.kind === "text" ? text : undefined,
          profileName: names.get(from),
        });
      }
    }
    // Message status updates
    const statuses = value.statuses ?? [];
    for (const s of statuses) {
      if (!s?.id) continue;
      await this.applyMessageStatus(s);
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
   * One of Meta's delivery statuses for a campaign message. Meta does not
   * promise the order they arrive in, so a status only moves forward
   * (pending < sent < delivered < read) and an older one is ignored: a late
   * "delivered" no longer turns a "read" back. "failed" is terminal, and is
   * only taken while the message was not yet known to have arrived.
   *
   * A failure about the salon's account or the template (payment, token,
   * paused template...: meta-account-errors.ts) pauses the campaign, and the
   * message goes back to pending so "Reanudar" sends it again.
   */
  private async applyMessageStatus(s: any): Promise<void> {
    const recipient = await this.prisma.whatsAppCampaignRecipient.findFirst({
      where: { messageId: s.id },
      select: { id: true, campaignId: true, campaign: { select: { status: true } } },
    });
    if (!recipient) return;
    const at = metaTime(s.timestamp);

    if (s.status === "failed") {
      const code = s.errors?.[0]?.code;
      const accountReason = accountLevelReason(code === undefined || code === null ? null : Number(code));
      const campaignStatus = recipient.campaign?.status;
      if (
        accountReason &&
        (campaignStatus === WhatsAppCampaignStatus.sending || campaignStatus === WhatsAppCampaignStatus.paused)
      ) {
        await this.prisma.whatsAppCampaignRecipient.updateMany({
          where: { id: recipient.id, status: WhatsAppRecipientStatus.sent },
          data: { status: WhatsAppRecipientStatus.pending, externalError: `meta_${code}` },
        });
        await this.prisma.whatsAppCampaign.updateMany({
          where: { id: recipient.campaignId, status: WhatsAppCampaignStatus.sending },
          data: { status: WhatsAppCampaignStatus.paused, lastError: accountReason },
        });
        this.logger.warn(`WhatsApp campaign ${recipient.campaignId}: paused by a delivery failure (meta_${code})`);
        return;
      }
      await this.prisma.whatsAppCampaignRecipient.updateMany({
        where: {
          id: recipient.id,
          status: { in: [WhatsAppRecipientStatus.pending, WhatsAppRecipientStatus.sent] },
        },
        data: { status: WhatsAppRecipientStatus.failed, externalError: JSON.stringify(s.errors ?? []) },
      });
      return;
    }

    const target = DELIVERY_STEPS.find((step) => step === s.status);
    if (!target) return;
    const earlier = DELIVERY_STEPS.slice(0, DELIVERY_STEPS.indexOf(target));
    const data =
      target === WhatsAppRecipientStatus.sent
        ? { status: target, sentAt: at }
        : target === WhatsAppRecipientStatus.delivered
          ? { status: target, deliveredAt: at }
          : { status: target, readAt: at };
    await this.prisma.whatsAppCampaignRecipient.updateMany({
      where: { id: recipient.id, status: { in: earlier } },
      data,
    });
  }

  /**
   * BAJA / STOP from a number: the clients with that number stop getting
   * WhatsApp promotions (consent withdrawn, as the client's own act) and any
   * campaign message still waiting for them is not sent.
   *
   * Written down before anything else (one row per message, so Meta's
   * retries change nothing). If even that fails, OptOutNotRecordedError
   * makes the webhook answer 500 and Meta delivers it again; it used to be
   * logged, answered 200 and lost. Applying it is retried by
   * retryPendingOptOuts until it succeeds.
   */
  private async optOut(tenantId: string, from: string, messageId: string): Promise<void> {
    let row: WhatsAppOptOut;
    try {
      row = await this.prisma.whatsAppOptOut.upsert({
        where: { tenantId_messageId: { tenantId, messageId } },
        create: { tenantId, messageId, phone: from },
        update: {},
      });
    } catch (err) {
      throw new OptOutNotRecordedError(`WhatsApp opt-out for tenant ${tenantId} not recorded: ${(err as Error).message}`);
    }
    if (!row.processedAt && !(await this.applyOptOut(row))) return;
    // Not awaited: the webhook answers Meta at once. Claimed, so a retried
    // delivery does not send it twice.
    void this.confirmOptOut(row.id);
  }

  /**
   * "Hecho. No te enviaremos más promociones de {salón}...": the reply to a
   * BAJA, once it is applied. Inside the 24-hour window the BAJA opened, so
   * a free text is allowed. At most once per BAJA (confirmedAt is claimed
   * before sending); a failed send is not retried. The number is wiped
   * afterwards either way. Never throws.
   */
  private async confirmOptOut(rowId: string): Promise<boolean> {
    try {
      const claimed = await this.prisma.whatsAppOptOut.updateMany({
        where: { id: rowId, processedAt: { not: null }, confirmedAt: null, phone: { not: "" } },
        data: { confirmedAt: new Date() },
      });
      if (claimed.count === 0) return false;
      const row = await this.prisma.whatsAppOptOut.findUnique({ where: { id: rowId } });
      if (!row) return false;
      try {
        const [conn, tenant] = await Promise.all([
          this.prisma.whatsAppConnection.findUnique({
            where: { tenantId: row.tenantId },
            select: { phoneNumberId: true, accessTokenEnc: true, isActive: true, authErrorAt: true },
          }),
          this.prisma.tenant.findUnique({ where: { id: row.tenantId }, select: { name: true } }),
        ]);
        if (!conn?.isActive || conn.authErrorAt || !conn.phoneNumberId) return false;
        const sent = await this.meta.sendText(
          this.meta.decryptToken(conn.accessTokenEnc),
          conn.phoneNumberId,
          row.phone,
          optOutConfirmation(tenant?.name),
        );
        if (sent?.error) {
          this.logger.warn(`BAJA confirmation for tenant ${row.tenantId} not sent: ${sent.error.code} ${sent.error.message}`);
          await this.health?.whatsAppError(row.tenantId, sent.error.code);
          return false;
        }
        return true;
      } finally {
        await this.prisma.whatsAppOptOut.update({ where: { id: row.id }, data: { phone: "" } }).catch(() => undefined);
      }
    } catch (err) {
      this.logger.warn(`BAJA confirmation ${rowId} failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Matched on the last nine digits: Meta sends "34600111222", the client
   * file may say "600 111 222" (the old lookup by substring never matched
   * those). Never throws: a failure stays on the row for the next sweep.
   */
  private async applyOptOut(row: WhatsAppOptOut): Promise<boolean> {
    const { tenantId } = row;
    try {
      const key = phoneKey(row.phone);
      const rows =
        key.length === 9
          ? await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM clients
      WHERE "tenantId" = ${tenantId}
        AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 9) = ${key}`
          : [];
      for (const { id } of rows) {
        await this.consent.recordMarketingChoice({ tenantId, clientId: id, accepts: false, channel: "whatsapp" });
        await this.prisma.whatsAppCampaignRecipient.updateMany({
          where: { clientId: id, status: WhatsAppRecipientStatus.pending },
          data: { status: WhatsAppRecipientStatus.opted_out },
        });
      }
      // Done. The number is kept only for the confirmation (confirmOptOut
      // wipes it); the consent record keeps the proof.
      await this.prisma.whatsAppOptOut.update({
        where: { id: row.id },
        data: { processedAt: new Date(), clientsFound: rows.length, lastError: null },
      });
      this.logger.log(`WhatsApp opt-out for tenant ${tenantId}: ${rows.length} client(s)`);
      return true;
    } catch (err) {
      this.logger.warn(`WhatsApp opt-out ${row.id} of tenant ${tenantId} not applied yet: ${(err as Error).message}`);
      await this.prisma.whatsAppOptOut
        .update({
          where: { id: row.id },
          data: { attempts: { increment: 1 }, lastError: (err as Error).message.slice(0, 500) },
        })
        .catch(() => undefined);
      return false;
    }
  }

  /** Opt-outs written but not applied (the database failed half-way): tried again. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  @MonitoredJob("WhatsAppService.retryPendingOptOuts")
  async retryPendingOptOuts(): Promise<number> {
    let applied = 0;
    try {
      const pending = await runUnscoped(() =>
        this.prisma.whatsAppOptOut.findMany({
          where: { processedAt: null, attempts: { lt: 100 }, createdAt: { lt: new Date(Date.now() - 60 * 1000) } },
          orderBy: { createdAt: "asc" },
          take: 100,
        }),
      );
      for (const row of pending) {
        if (!(await runUnscoped(() => this.applyOptOut(row)))) continue;
        applied++;
        // Still inside the BAJA's 24-hour window: it gets its confirmation now.
        if (Date.now() - row.createdAt.getTime() < OPT_OUT_CONFIRM_WINDOW_MS) {
          await runUnscoped(() => this.confirmOptOut(row.id));
        }
      }
      // Applied but never confirmed (a restart in between): confirmed, or
      // the number wiped once the window has passed.
      const unconfirmed = await runUnscoped(() =>
        this.prisma.whatsAppOptOut.findMany({
          where: { processedAt: { not: null }, confirmedAt: null, phone: { not: "" } },
          select: { id: true, createdAt: true },
          take: 100,
        }),
      );
      for (const row of unconfirmed) {
        if (Date.now() - row.createdAt.getTime() < OPT_OUT_CONFIRM_WINDOW_MS) {
          await runUnscoped(() => this.confirmOptOut(row.id));
        } else {
          await runUnscoped(() =>
            this.prisma.whatsAppOptOut.update({ where: { id: row.id }, data: { phone: "" } }),
          ).catch(() => undefined);
        }
      }
    } catch (err) {
      this.logger.error(`WhatsApp opt-out retry failed: ${(err as Error).message}`);
    }
    return applied;
  }
}
