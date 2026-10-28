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
  updatedAt: string | null;
  updatedBy: string | null;
}

/** For each field: a string sets it, null clears it (back to .env), absent keeps it. */
export interface PlatformEmailConfigUpdate {
  apiKey?: string | null;
  from?: string | null;
  webhookSecret?: string | null;
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

  getConfig(): PlatformEmailConfigPublic {
    const { sources, apiKey, from, webhookSecret } = this.settings;
    return {
      apiKey: { source: sources.apiKey, lastFour: lastFour(apiKey) },
      from: { source: sources.from, value: from },
      webhookSecret: { source: sources.webhookSecret, lastFour: lastFour(webhookSecret) },
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
      null;
    if (problem) throw new BadRequestException(problem);

    const data: { apiKeyEncrypted?: string | null; fromAddress?: string | null; webhookSecretEncrypted?: string | null } = {};
    if (input.apiKey !== undefined) data.apiKeyEncrypted = input.apiKey === null ? null : this.encryption.encrypt(input.apiKey.trim());
    if (input.from !== undefined) data.fromAddress = input.from === null ? null : input.from.trim();
    if (input.webhookSecret !== undefined) {
      data.webhookSecretEncrypted = input.webhookSecret === null ? null : this.encryption.encrypt(input.webhookSecret.trim());
    }
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
