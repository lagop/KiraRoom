import { ForbiddenException, BadRequestException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { UserRole } from "@prisma/client";
import { Resend } from "resend";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import { AuditLogService } from "../saas/audit-log.service";
import {
  EmailSettings,
  EmailSettingsWithSources,
  EmailSettingSource,
  apiKeyProblem,
  lastFour,
  parseSender,
  redactSecrets,
  resolveEmailSettings,
  senderProblem,
  webhookSecretProblem,
} from "./email-settings";

/** What the console shows: never a key or a secret, only where each comes from. */
export interface PlatformEmailConfigPublic {
  apiKey: { source: EmailSettingSource; lastFour: string | null };
  from: { source: EmailSettingSource; value: string | null };
  webhookSecret: { source: EmailSettingSource; lastFour: string | null };
  /** The bono de emails salons can buy: not offered while either value is empty. */
  marketingPack: { emails: number | null; priceCents: number | null; offered: boolean };
  updatedAt: string | null;
  updatedBy: string | null;
}

/** For each field: a string sets it, null clears it (back to .env), absent keeps it. */
export interface PlatformEmailConfigUpdate {
  apiKey?: string | null;
  from?: string | null;
  webhookSecret?: string | null;
  /** Emails in a bono de emails; null stops offering it. */
  marketingPackEmails?: number | null;
  /** Its price in cents, before VAT; null stops offering it. */
  marketingPackPriceCents?: number | null;
}

/** A bono de emails as salons are offered it. */
export interface MarketingEmailPack {
  emails: number;
  priceCents: number;
}

export const PACK_EMAILS_MIN = 100;
export const PACK_EMAILS_MAX = 100_000;
export const PACK_PRICE_MIN_CENTS = 50;
export const PACK_PRICE_MAX_CENTS = 1_000_000;

/** Why a bono's size or price cannot be saved, in Spanish; null when it can. */
export function marketingPackProblem(input: { emails?: number | null; priceCents?: number | null }): string | null {
  const { emails, priceCents } = input;
  if (emails !== undefined && emails !== null) {
    if (!Number.isInteger(emails) || emails < PACK_EMAILS_MIN || emails > PACK_EMAILS_MAX) {
      return `El bono debe tener entre ${PACK_EMAILS_MIN} y ${PACK_EMAILS_MAX.toLocaleString("es-ES")} emails.`;
    }
  }
  if (priceCents !== undefined && priceCents !== null) {
    if (!Number.isInteger(priceCents) || priceCents < PACK_PRICE_MIN_CENTS || priceCents > PACK_PRICE_MAX_CENTS) {
      return "El precio del bono debe estar entre 0,50 € y 10.000 €, en céntimos enteros.";
    }
  }
  return null;
}

interface Actor {
  id: string;
  role: string;
}

/**
 * The platform's email settings (Resend API key, sender, webhook secret),
 * set by the saas_owner in the console instead of only in the server's .env.
 *
 * Kept in memory and reloaded on every change, so EmailService and the
 * Resend webhook read them synchronously and a new key works at once,
 * without a restart. The key and the secret are encrypted at rest
 * (EncryptionService) and never leave the server: the console only sees
 * where each setting comes from and the key's last four characters.
 *
 * Whoever holds the key can send email as KiraRoom, so changing it needs
 * two-step sign-in on the account doing it, and every change is audited
 * (which fields, never their values).
 */
@Injectable()
export class PlatformEmailConfigService implements OnModuleInit {
  private readonly logger = new Logger(PlatformEmailConfigService.name);
  private settings: EmailSettingsWithSources;
  private stored: { updatedAt: Date; updatedBy: string | null } | null = null;
  private pack: { emails: number | null; priceCents: number | null } = { emails: null, priceCents: null };

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
    private readonly auditLog: AuditLogService,
  ) {
    // Until the stored row is read, the server's values apply.
    this.settings = resolveEmailSettings({}, this.serverSettings());
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.reload();
    } catch (err) {
      this.logger.warn(`Platform email settings not loaded, using the server's: ${(err as Error).message}`);
    }
    const { sources } = this.settings;
    this.logger.log(`Email: API key from ${sources.apiKey}, sender from ${sources.from}, webhook secret from ${sources.webhookSecret}`);
  }

  /** The settings in force. Synchronous: read on every send. */
  current(): EmailSettings {
    const { apiKey, from, webhookSecret } = this.settings;
    return { apiKey, from, webhookSecret };
  }

  /**
   * The bono de emails salons are offered once their month's marketing cap
   * is reached (email-campaigns/email-quota.service.ts), set by the
   * saas_owner here. Null until both its size and its price are set.
   */
  marketingPack(): MarketingEmailPack | null {
    const { emails, priceCents } = this.pack;
    if (!emails || !priceCents || emails <= 0 || priceCents <= 0) return null;
    return { emails, priceCents };
  }

  getConfig(): PlatformEmailConfigPublic {
    const { sources, apiKey, from, webhookSecret } = this.settings;
    return {
      apiKey: { source: sources.apiKey, lastFour: lastFour(apiKey) },
      from: { source: sources.from, value: from },
      webhookSecret: { source: sources.webhookSecret, lastFour: lastFour(webhookSecret) },
      marketingPack: { ...this.pack, offered: this.marketingPack() !== null },
      updatedAt: this.stored?.updatedAt.toISOString() ?? null,
      updatedBy: this.stored?.updatedBy ?? null,
    };
  }

  async update(input: PlatformEmailConfigUpdate, actor: Actor): Promise<PlatformEmailConfigPublic> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { twoFactorEnabled: true, email: true },
    });
    if (!user?.twoFactorEnabled) {
      throw new ForbiddenException(
        "Para cambiar el email de la plataforma, activa antes la verificación en dos pasos en Seguridad.",
      );
    }

    const problem =
      (typeof input.apiKey === "string" && apiKeyProblem(input.apiKey)) ||
      (typeof input.from === "string" && senderProblem(input.from)) ||
      (typeof input.webhookSecret === "string" && webhookSecretProblem(input.webhookSecret)) ||
      marketingPackProblem({ emails: input.marketingPackEmails, priceCents: input.marketingPackPriceCents }) ||
      null;
    if (problem) throw new BadRequestException(problem);

    const data: {
      apiKeyEncrypted?: string | null;
      fromAddress?: string | null;
      webhookSecretEncrypted?: string | null;
      marketingPackEmails?: number | null;
      marketingPackPriceCents?: number | null;
    } = {};
    if (input.apiKey !== undefined) data.apiKeyEncrypted = input.apiKey === null ? null : this.encryption.encrypt(input.apiKey.trim());
    if (input.from !== undefined) data.fromAddress = input.from === null ? null : input.from.trim();
    if (input.webhookSecret !== undefined) {
      data.webhookSecretEncrypted = input.webhookSecret === null ? null : this.encryption.encrypt(input.webhookSecret.trim());
    }
    if (input.marketingPackEmails !== undefined) data.marketingPackEmails = input.marketingPackEmails;
    if (input.marketingPackPriceCents !== undefined) data.marketingPackPriceCents = input.marketingPackPriceCents;
    const changed = Object.keys(data);
    if (changed.length === 0) return this.getConfig();

    await this.prisma.platformEmailConfig.upsert({
      where: { id: "global" },
      create: { id: "global", ...data, updatedBy: user.email },
      update: { ...data, updatedBy: user.email },
    });
    await this.auditLog.record("platform.email_config.updated", {
      actorId: actor.id,
      actorRole: actor.role as UserRole,
      // Which settings were set or cleared; never their values.
      metadata: {
        set: Object.entries(input).filter(([, v]) => typeof v === "string").map(([k]) => k),
        cleared: Object.entries(input).filter(([, v]) => v === null).map(([k]) => k),
        // The bono's size and price are not secret: what it changed to.
        ...(input.marketingPackEmails !== undefined || input.marketingPackPriceCents !== undefined
          ? { marketingPack: { emails: data.marketingPackEmails, priceCents: data.marketingPackPriceCents } }
          : {}),
      },
    });
    await this.reload();
    this.logger.log(`Platform email settings changed by ${actor.id}: ${changed.join(", ")}`);
    return this.getConfig();
  }

  /**
   * Sends a short email to the signed-in admin with the settings in force,
   * so a wrong key or an unverified domain shows up as Resend's own reason.
   */
  async sendTest(actor: Actor): Promise<{ ok: boolean; message: string }> {
    const { apiKey, from } = this.current();
    if (!apiKey) return { ok: false, message: "No hay clave de Resend, ni en la consola ni en el servidor." };
    if (!from || !parseSender(from)) return { ok: false, message: "Falta la dirección de envío." };
    const user = await this.prisma.user.findUnique({ where: { id: actor.id }, select: { email: true } });
    if (!user?.email) return { ok: false, message: "Tu cuenta no tiene email al que enviar la prueba." };

    try {
      const { data, error } = await new Resend(apiKey).emails.send({
        from,
        to: [user.email],
        subject: "Prueba de email de KiraRoom",
        text: `Si lees esto, KiraRoom envía emails desde ${from}.`,
        html: `<p>Si lees esto, KiraRoom envía emails desde <strong>${parseSender(from)!.address}</strong>.</p>`,
      });
      if (error) return { ok: false, message: `Resend: ${redactSecrets(error.message)}` };
      return { ok: true, message: `Enviado a ${user.email} (id ${data?.id ?? "?"}). Mira también la carpeta de spam.` };
    } catch (err) {
      return { ok: false, message: `Resend: ${redactSecrets((err as Error).message ?? "error desconocido")}` };
    }
  }

  private async reload(): Promise<void> {
    const row = await this.prisma.platformEmailConfig.findUnique({ where: { id: "global" } });
    this.stored = row ? { updatedAt: row.updatedAt, updatedBy: row.updatedBy } : null;
    this.pack = { emails: row?.marketingPackEmails ?? null, priceCents: row?.marketingPackPriceCents ?? null };
    this.settings = resolveEmailSettings(
      row
        ? {
            apiKey: this.decrypt(row.apiKeyEncrypted, "API key"),
            from: row.fromAddress,
            webhookSecret: this.decrypt(row.webhookSecretEncrypted, "webhook secret"),
          }
        : {},
      this.serverSettings(),
    );
  }

  private decrypt(value: string | null, what: string): string | null {
    if (!value) return null;
    try {
      return this.encryption.decrypt(value);
    } catch (err) {
      // The encryption key changed or the value is corrupt: fall back to
      // the server's setting and say so, rather than failing every send.
      this.logger.error(`Stored email ${what} cannot be decrypted; re-enter it in the console: ${(err as Error).message}`);
      return null;
    }
  }

  private serverSettings(): Partial<EmailSettings> {
    return {
      apiKey: this.config.get<string>("RESEND_API_KEY"),
      from: this.config.get<string>("EMAIL_FROM"),
      webhookSecret: this.config.get<string>("RESEND_WEBHOOK_SECRET"),
    };
  }
}
