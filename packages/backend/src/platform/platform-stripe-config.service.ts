import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { UserRole } from "@prisma/client";
import Stripe from "stripe";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import { AuditLogService } from "../saas/audit-log.service";
import { lastFour } from "./email-settings";
import {
  SettingSource,
  StripeMode,
  StripeSettings,
  StripeSettingsWithSources,
  keyMode,
  publishableKeyProblem,
  resolveStripeSettings,
  secretKeyProblem,
  stripeConsistencyProblem,
  stripeWebhookSecretProblem,
} from "./stripe-settings";

const API_VERSION = "2024-12-18.acacia" as any;

/** What the console shows: never the secret key or the webhook secret. */
export interface PlatformStripeConfigPublic {
  mode: StripeMode;
  secretKey: { source: SettingSource; lastFour: string | null };
  publishableKey: { source: SettingSource; value: string | null };
  webhookSecret: { source: SettingSource; lastFour: string | null };
  taxEnabled: { source: SettingSource; value: boolean };
  updatedAt: string | null;
  updatedBy: string | null;
}

/** A string (or boolean) sets a field, null clears it (back to .env), absent keeps it. */
export interface PlatformStripeConfigUpdate {
  secretKey?: string | null;
  publishableKey?: string | null;
  webhookSecret?: string | null;
  taxEnabled?: boolean | null;
}

interface Actor {
  id: string;
  role: string;
}

/**
 * KiraRoom's own Stripe account (it bills the salons' subscriptions, add-ons
 * and message packs), set by the saas_owner in the console instead of only
 * in the server's .env. Salons' own accounts, for their clients, are
 * separate (StripeService.getStripeForTenant).
 *
 * Same rules as the email settings (PlatformEmailConfigService): kept in
 * memory and reloaded on every change, so a new key works at once; secret
 * key and webhook secret encrypted at rest and never returned; changing
 * them needs two-step sign-in; every change is audited without values.
 * On top: a secret key is only accepted with a webhook secret, and both keys
 * must be from the same mode (test or live).
 */
@Injectable()
export class PlatformStripeConfigService implements OnModuleInit {
  private readonly logger = new Logger(PlatformStripeConfigService.name);
  private settings: StripeSettingsWithSources;
  private stored: { updatedAt: Date; updatedBy: string | null } | null = null;
  private stripe: Stripe | null = null;
  /** The key `stripe` was built with: a new one builds a new client. */
  private stripeKey: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly config: ConfigService,
    private readonly auditLog: AuditLogService,
  ) {
    this.settings = resolveStripeSettings({}, this.serverSettings());
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.reload();
    } catch (err) {
      this.logger.warn(`Platform Stripe settings not loaded, using the server's: ${(err as Error).message}`);
    }
    const { sources } = this.settings;
    this.logger.log(
      `Stripe: ${keyMode(this.settings.secretKey)} mode, secret key from ${sources.secretKey}, webhook secret from ${sources.webhookSecret}, tax ${this.settings.taxEnabled ? "on" : "off"}`,
    );
  }

  /** The settings in force. Synchronous: read on every payment. */
  current(): StripeSettings {
    const { secretKey, publishableKey, webhookSecret, taxEnabled } = this.settings;
    return { secretKey, publishableKey, webhookSecret, taxEnabled };
  }

  /** The Stripe client for the platform account, or null when there is no key. */
  client(): Stripe | null {
    const key = this.settings.secretKey;
    if (!key || !key.startsWith("sk_")) return null;
    if (!this.stripe || key !== this.stripeKey) {
      this.stripe = new Stripe(key, { apiVersion: API_VERSION });
      this.stripeKey = key;
    }
    return this.stripe;
  }

  getConfig(): PlatformStripeConfigPublic {
    const { sources, secretKey, publishableKey, webhookSecret, taxEnabled } = this.settings;
    return {
      mode: keyMode(secretKey),
      secretKey: { source: sources.secretKey, lastFour: lastFour(secretKey) },
      publishableKey: { source: sources.publishableKey, value: publishableKey },
      webhookSecret: { source: sources.webhookSecret, lastFour: lastFour(webhookSecret) },
      taxEnabled: { source: sources.taxEnabled, value: taxEnabled },
      updatedAt: this.stored?.updatedAt.toISOString() ?? null,
      updatedBy: this.stored?.updatedBy ?? null,
    };
  }

  async update(input: PlatformStripeConfigUpdate, actor: Actor): Promise<PlatformStripeConfigPublic> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { twoFactorEnabled: true, email: true },
    });
    if (!user?.twoFactorEnabled) {
      throw new ForbiddenException(
        "Para cambiar Stripe de la plataforma, activa antes la verificación en dos pasos en Seguridad.",
      );
    }

    const problem =
      (typeof input.secretKey === "string" && secretKeyProblem(input.secretKey)) ||
      (typeof input.publishableKey === "string" && publishableKeyProblem(input.publishableKey)) ||
      (typeof input.webhookSecret === "string" && stripeWebhookSecretProblem(input.webhookSecret)) ||
      null;
    if (problem) throw new BadRequestException(problem);

    const data: {
      secretKeyEncrypted?: string | null;
      publishableKey?: string | null;
      webhookSecretEncrypted?: string | null;
      taxEnabled?: boolean | null;
    } = {};
    if (input.secretKey !== undefined) {
      data.secretKeyEncrypted = input.secretKey === null ? null : this.encryption.encrypt(input.secretKey.trim());
    }
    if (input.publishableKey !== undefined) data.publishableKey = input.publishableKey === null ? null : input.publishableKey.trim();
    if (input.webhookSecret !== undefined) {
      data.webhookSecretEncrypted = input.webhookSecret === null ? null : this.encryption.encrypt(input.webhookSecret.trim());
    }
    if (input.taxEnabled !== undefined) data.taxEnabled = input.taxEnabled;
    if (Object.keys(data).length === 0) return this.getConfig();

    // Refuse a change that would leave payments half-configured.
    const row = await this.prisma.platformStripeConfig.findUnique({ where: { id: "global" } });
    const after = resolveStripeSettings(
      {
        secretKey: input.secretKey !== undefined ? input.secretKey : this.decrypt(row?.secretKeyEncrypted ?? null, "secret key"),
        publishableKey: input.publishableKey !== undefined ? input.publishableKey : row?.publishableKey,
        webhookSecret:
          input.webhookSecret !== undefined ? input.webhookSecret : this.decrypt(row?.webhookSecretEncrypted ?? null, "webhook secret"),
        taxEnabled: input.taxEnabled !== undefined ? input.taxEnabled : row?.taxEnabled,
      },
      this.serverSettings(),
    );
    const inconsistent = stripeConsistencyProblem(after);
    if (inconsistent) throw new BadRequestException(inconsistent);

    await this.prisma.platformStripeConfig.upsert({
      where: { id: "global" },
      create: { id: "global", ...data, updatedBy: user.email },
      update: { ...data, updatedBy: user.email },
    });
    await this.auditLog.record("platform.stripe_config.updated", {
      actorId: actor.id,
      actorRole: actor.role as UserRole,
      // Which settings were set or cleared, and the mode; never the keys.
      metadata: {
        set: Object.entries(input).filter(([, v]) => v !== null && v !== undefined).map(([k]) => k),
        cleared: Object.entries(input).filter(([, v]) => v === null).map(([k]) => k),
        mode: keyMode(after.secretKey),
        taxEnabled: after.taxEnabled,
      },
    });
    await this.reload();
    this.logger.log(`Platform Stripe settings changed by ${actor.id}: ${Object.keys(data).join(", ")} (${keyMode(after.secretKey)} mode)`);
    return this.getConfig();
  }

  /**
   * Reads the account the secret key belongs to, so the admin can see it is
   * KiraRoom's (not another business's) and whether it can take charges.
   */
  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const stripe = this.client();
    if (!stripe) return { ok: false, message: "No hay clave secreta de Stripe, ni en la consola ni en el servidor." };
    try {
      const account = await stripe.accounts.retrieve();
      const name = account.business_profile?.name || account.settings?.dashboard?.display_name || account.email || account.id;
      const mode = keyMode(this.settings.secretKey) === "live" ? "real" : "de pruebas";
      const charges = account.charges_enabled
        ? "puede cobrar"
        : "aún no puede cobrar (revisa la activación en Stripe)";
      return { ok: true, message: `Conectado a «${name}» en modo ${mode}: ${charges}.` };
    } catch (err) {
      return { ok: false, message: `Stripe: ${redactStripe((err as Error).message ?? "error desconocido")}` };
    }
  }

  private async reload(): Promise<void> {
    const row = await this.prisma.platformStripeConfig.findUnique({ where: { id: "global" } });
    this.stored = row ? { updatedAt: row.updatedAt, updatedBy: row.updatedBy } : null;
    this.settings = resolveStripeSettings(
      row
        ? {
            secretKey: this.decrypt(row.secretKeyEncrypted, "secret key"),
            publishableKey: row.publishableKey,
            webhookSecret: this.decrypt(row.webhookSecretEncrypted, "webhook secret"),
            taxEnabled: row.taxEnabled,
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
      // The encryption key changed or the value is corrupt: fall back to the
      // server's setting and say so, rather than failing every payment.
      this.logger.error(`Stored Stripe ${what} cannot be decrypted; re-enter it in the console: ${(err as Error).message}`);
      return null;
    }
  }

  private serverSettings() {
    return {
      secretKey: this.config.get<string>("STRIPE_SECRET_KEY"),
      publishableKey: this.config.get<string>("STRIPE_PUBLISHABLE_KEY"),
      webhookSecret: this.config.get<string>("STRIPE_WEBHOOK_SECRET"),
      taxEnabled: this.config.get<string>("STRIPE_TAX_ENABLED"),
    };
  }
}

/** Take any Stripe key or webhook secret out of an error before showing it. */
export function redactStripe(message: string): string {
  return message.replace(/(sk|rk|pk)_(test|live)_[A-Za-z0-9]{4,}/g, "$1_$2_***").replace(/whsec_[A-Za-z0-9]{4,}/g, "whsec_***");
}
