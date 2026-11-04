import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Prisma, UserRole } from "@prisma/client";
import Stripe from "stripe";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import { AuditLogService } from "../saas/audit-log.service";
import { lastFour } from "./email-settings";
import {
  SettingSource,
  StoredStripeSettings,
  StripeField,
  StripeMode,
  StripeSettings,
  StripeSettingsWithSources,
  keyMode,
  livemodeOf,
  otherMode,
  publishableKeyProblem,
  resolveStripeSettings,
  secretKeyProblem,
  stripeConsistencyProblem,
  stripeWebhookSecretProblem,
} from "./stripe-settings";

const API_VERSION = "2024-12-18.acacia" as any;

/** What the console shows: never the secret key or the webhook secrets. */
export interface PlatformStripeConfigPublic {
  mode: StripeMode;
  secretKey: { source: SettingSource; lastFour: string | null };
  publishableKey: { source: SettingSource; value: string | null };
  webhookSecret: { source: SettingSource; lastFour: string | null };
  /** The other mode's webhook secret: its events are verified and ignored. */
  otherWebhookSecret: { source: SettingSource; lastFour: string | null; mode: StripeMode };
  /** What the server's .env holds, for "Volver a lo del servidor". */
  server: { mode: StripeMode; hasWebhookSecret: boolean };
  /** Why the settings in force cannot take payments safely, in Spanish; null when they can. */
  problem: string | null;
  /** Stripe Tax was switched on (console or .env) and is ignored (D6). */
  taxIgnored: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** A string sets a field, null clears it (back to .env), absent keeps it. */
export interface PlatformStripeConfigUpdate {
  secretKey?: string | null;
  publishableKey?: string | null;
  webhookSecret?: string | null;
  otherWebhookSecret?: string | null;
}

/** Salons whose Stripe customer or plan subscription belong to another mode than `mode`. */
export interface StripeModeImpact {
  /** Salons with a customer or a subscription of the other mode. */
  otherModeSalons: number;
  /** Their plans still counted as paid (active, trial with a subscription, past due). */
  activePlansTotal: number;
  activePlans: Array<{ id: string; name: string; slug: string | null; plan: string | null; subscriptionStatus: string | null }>;
}

export interface StripeChangePreview {
  modeBefore: StripeMode;
  modeAfter: StripeMode;
  /** Why the change would be refused, in Spanish; null when it would be saved. */
  problem: string | null;
  /** Only when the mode changes to test or live. */
  impact: StripeModeImpact | null;
}

interface Actor {
  id: string;
  role: string;
}

/** A stored row read and decrypted: the values and which could not be decrypted. */
interface StoredState {
  values: StoredStripeSettings;
  unreadable: Partial<Record<StripeField, boolean>>;
}

/** The change computed by `plan`: what the row becomes and what is then in force. */
interface PlannedChange {
  before: StripeSettingsWithSources;
  after: StripeSettingsWithSources;
  next: StoredState;
  problem: string | null;
  /** Fields whose stored value changes (set, cleared or moved). */
  changed: StripeField[];
}

const ACTIVE_PLAN_STATUSES = ["active", "trialing", "past_due"];

/**
 * KiraRoom's own Stripe account (it bills the salons' subscriptions, add-ons
 * and message packs), set by the saas_owner in the console instead of only
 * in the server's .env. Salons' own accounts, for their clients, are
 * separate (StripeService.getStripeForTenant).
 *
 * Same rules as the email settings (PlatformEmailConfigService): kept in
 * memory and reloaded on every change, so a new key works at once; secret
 * key and webhook secrets encrypted at rest and never returned; changing
 * them needs two-step sign-in; every change is audited without values.
 * On top (stripeConsistencyProblem): the secret key and its webhook secret
 * come from the same place, both keys are of the same mode, and a value that
 * cannot be decrypted leaves Stripe unconfigured instead of silently using
 * the .env (which would switch modes).
 *
 * Switching modes keeps the old mode's webhook secret as the "other mode"
 * one, so that mode's late events are acknowledged (and ignored) instead of
 * failing; switching back with the other mode's secret stored swaps them.
 */
@Injectable()
export class PlatformStripeConfigService implements OnModuleInit {
  private readonly logger = new Logger(PlatformStripeConfigService.name);
  private settings: StripeSettingsWithSources;
  private stored: { updatedAt: Date; updatedBy: string | null } | null = null;
  private problem: string | null = null;
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
      `Stripe: ${keyMode(this.settings.secretKey)} mode, secret key from ${sources.secretKey}, webhook secret from ${sources.webhookSecret}, other mode's webhook secret from ${sources.otherWebhookSecret}`,
    );
  }

  /** The settings in force. Synchronous: read on every payment. */
  current(): StripeSettings {
    const { secretKey, publishableKey, webhookSecret, otherWebhookSecret, taxEnabled } = this.settings;
    return { secretKey, publishableKey, webhookSecret, otherWebhookSecret, taxEnabled };
  }

  /** The mode of the secret key in force. */
  mode(): StripeMode {
    return keyMode(this.settings.secretKey);
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
    const { sources, secretKey, publishableKey, webhookSecret, otherWebhookSecret, taxIgnored } = this.settings;
    const server = this.serverSettings();
    return {
      mode: keyMode(secretKey),
      secretKey: { source: sources.secretKey, lastFour: lastFour(secretKey) },
      publishableKey: { source: sources.publishableKey, value: publishableKey },
      webhookSecret: { source: sources.webhookSecret, lastFour: lastFour(webhookSecret) },
      otherWebhookSecret: {
        source: sources.otherWebhookSecret,
        lastFour: lastFour(otherWebhookSecret),
        mode: otherMode(keyMode(secretKey)),
      },
      server: { mode: keyMode(server.secretKey?.trim()), hasWebhookSecret: !!server.webhookSecret?.trim() },
      problem: this.problem,
      taxIgnored,
      updatedAt: this.stored?.updatedAt.toISOString() ?? null,
      updatedBy: this.stored?.updatedBy ?? null,
    };
  }

  /**
   * What saving `input` would do, without saving: the mode before and
   * after, why it would be refused, and on a mode change the salons left
   * with the other mode's customer or subscription. The console shows it
   * before "Guardar" and "Volver a lo del servidor".
   */
  async preview(input: PlatformStripeConfigUpdate): Promise<StripeChangePreview> {
    const format = this.formatProblem(input);
    const change = await this.plan(input);
    const modeBefore = keyMode(change.before.secretKey);
    const modeAfter = keyMode(change.after.secretKey);
    return {
      modeBefore,
      modeAfter,
      problem: format ?? change.problem,
      impact: modeAfter !== modeBefore && modeAfter !== "none" ? await this.modeImpact(modeAfter) : null,
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

    const format = this.formatProblem(input);
    if (format) throw new BadRequestException(format);

    const change = await this.plan(input);
    if (change.changed.length === 0) return this.getConfig();
    // Refuse a change that would leave payments half-configured.
    if (change.problem) throw new BadRequestException(change.problem);

    const data: Prisma.PlatformStripeConfigUncheckedCreateInput = { id: "global" };
    const seal = (v: string | null | undefined) => (v ? this.encryption.encrypt(v) : null);
    for (const field of change.changed) {
      const value = change.next.values[field] ?? null;
      if (field === "secretKey") data.secretKeyEncrypted = seal(value);
      if (field === "publishableKey") data.publishableKey = value;
      if (field === "webhookSecret") data.webhookSecretEncrypted = seal(value);
      if (field === "otherWebhookSecret") data.otherWebhookSecretEncrypted = seal(value);
    }
    // Stripe Tax stays off (D6): a value stored before is dropped.
    data.taxEnabled = null;
    const { id: _id, ...updateData } = data;
    void _id;

    await this.prisma.platformStripeConfig.upsert({
      where: { id: "global" },
      create: { ...data, updatedBy: user.email },
      update: { ...updateData, updatedBy: user.email },
    });
    const modeBefore = keyMode(change.before.secretKey);
    const modeAfter = keyMode(change.after.secretKey);
    await this.auditLog.record("platform.stripe_config.updated", {
      actorId: actor.id,
      actorRole: actor.role as UserRole,
      // Which settings were set, cleared or moved, and the modes; never the keys.
      metadata: {
        set: change.changed.filter((f) => !!change.next.values[f]),
        cleared: change.changed.filter((f) => !change.next.values[f]),
        mode: modeAfter,
        ...(modeBefore !== modeAfter ? { modeBefore } : {}),
      },
    });
    await this.reload();
    this.logger.log(
      `Platform Stripe settings changed by ${actor.id}: ${change.changed.join(", ")} (${modeBefore} -> ${modeAfter} mode)`,
    );
    return this.getConfig();
  }

  /**
   * Reads the account a secret key belongs to, so the admin can see it is
   * KiraRoom's (not another business's) and whether it can take charges.
   * With `secretKey` it tests that typed key without saving it; without,
   * the key in force.
   */
  async testConnection(secretKey?: string | null): Promise<{ ok: boolean; message: string }> {
    const typed = secretKey?.trim();
    if (typed) {
      const problem = secretKeyProblem(typed);
      if (problem) return { ok: false, message: problem };
    }
    const stripe = typed ? new Stripe(typed, { apiVersion: API_VERSION }) : this.client();
    if (!stripe) {
      return {
        ok: false,
        message:
          this.settings.sources.secretKey === "unreadable"
            ? "La clave secreta guardada en la consola no se puede descifrar: vuelve a escribirla."
            : "No hay clave secreta de Stripe, ni en la consola ni en el servidor.",
      };
    }
    try {
      const account = await stripe.accounts.retrieve();
      const name = account.business_profile?.name || account.settings?.dashboard?.display_name || account.email || account.id;
      const mode = keyMode(typed || this.settings.secretKey) === "live" ? "real" : "de pruebas";
      const charges = account.charges_enabled
        ? "puede cobrar"
        : "aún no puede cobrar (revisa la activación en Stripe)";
      return {
        ok: true,
        message: typed
          ? `La clave escrita (aún sin guardar) es de «${name}», en modo ${mode}: ${charges}.`
          : `Conectado a «${name}» en modo ${mode}: ${charges}.`,
      };
    } catch (err) {
      return { ok: false, message: `Stripe: ${redactStripe((err as Error).message ?? "error desconocido")}` };
    }
  }

  /** Salons left with the other mode's customer or subscription when `mode` is in force. */
  async modeImpact(mode: StripeMode): Promise<StripeModeImpact> {
    const live = livemodeOf(mode);
    if (live === null) return { otherModeSalons: 0, activePlansTotal: 0, activePlans: [] };
    // Unknown mode (null) counts as the other one: it was never recorded.
    const otherCustomer: Prisma.TenantWhereInput = {
      stripeCustomerId: { not: null },
      OR: [{ stripeCustomerLivemode: !live }, { stripeCustomerLivemode: null }],
    };
    const otherSubscription: Prisma.TenantWhereInput = {
      stripeSubscriptionId: { not: null },
      OR: [{ stripeSubscriptionLivemode: !live }, { stripeSubscriptionLivemode: null }],
    };
    const activeWhere: Prisma.TenantWhereInput = {
      ...otherSubscription,
      subscriptionStatus: { in: ACTIVE_PLAN_STATUSES as any },
    };
    const [otherModeSalons, activePlansTotal, activePlans] = await Promise.all([
      this.prisma.tenant.count({ where: { OR: [otherCustomer, otherSubscription] } }),
      this.prisma.tenant.count({ where: activeWhere }),
      this.prisma.tenant.findMany({
        where: activeWhere,
        select: { id: true, name: true, slug: true, plan: true, subscriptionStatus: true },
        orderBy: { name: "asc" },
        take: 50,
      }),
    ]);
    return {
      otherModeSalons,
      activePlansTotal,
      activePlans: activePlans.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug ?? null,
        plan: t.plan ? String(t.plan) : null,
        subscriptionStatus: t.subscriptionStatus ? String(t.subscriptionStatus) : null,
      })),
    };
  }

  /** A typed value that is not what its field expects, in Spanish; null when all are fine. */
  private formatProblem(input: PlatformStripeConfigUpdate): string | null {
    return (
      (typeof input.secretKey === "string" && secretKeyProblem(input.secretKey)) ||
      (typeof input.publishableKey === "string" && publishableKeyProblem(input.publishableKey)) ||
      (typeof input.webhookSecret === "string" && stripeWebhookSecretProblem(input.webhookSecret)) ||
      (typeof input.otherWebhookSecret === "string" && stripeWebhookSecretProblem(input.otherWebhookSecret)) ||
      null
    );
  }

  /**
   * The row after `input`, and what is then in force. On a switch between
   * test and live:
   * - with a new webhook secret (typed, or the .env's coming with the .env
   *   key), the old mode's console secret is kept as the other mode's;
   * - without one, the stored other mode's secret becomes the one in use
   *   and the old one the other's (switching back);
   * - with neither, the change is refused: the old secret is of the old
   *   mode, and no payment of the new one would be confirmed.
   */
  private async plan(input: PlatformStripeConfigUpdate): Promise<PlannedChange> {
    const row = await this.prisma.platformStripeConfig.findUnique({ where: { id: "global" } });
    const current = this.readRow(row);
    const server = this.serverSettings();
    const before = resolveStripeSettings(current.values, server, current.unreadable);

    const next: StoredState = { values: { ...current.values }, unreadable: { ...current.unreadable } };
    const fields: StripeField[] = ["secretKey", "publishableKey", "webhookSecret", "otherWebhookSecret"];
    for (const field of fields) {
      const value = input[field];
      if (value === undefined) continue;
      next.values[field] = value === null ? null : value.trim();
      next.unreadable[field] = false;
    }

    let after = resolveStripeSettings(next.values, server, next.unreadable);
    const modeBefore = keyMode(before.secretKey);
    const modeAfter = keyMode(after.secretKey);
    let problem: string | null = null;
    if (modeBefore !== "none" && modeAfter !== "none" && modeBefore !== modeAfter) {
      const newSecret = input.webhookSecret !== undefined || after.sources.webhookSecret !== before.sources.webhookSecret;
      const oldConsoleSecret = before.sources.webhookSecret === "console" ? before.webhookSecret : null;
      if (newSecret) {
        if (input.otherWebhookSecret === undefined) next.values.otherWebhookSecret = oldConsoleSecret;
      } else if (input.otherWebhookSecret === undefined && current.values.otherWebhookSecret) {
        next.values.webhookSecret = current.values.otherWebhookSecret;
        next.values.otherWebhookSecret = oldConsoleSecret;
      } else {
        problem = `Al pasar a modo ${modeAfter === "live" ? "real" : "de pruebas"}, pega también el secreto del webhook de ese modo: el que hay ahora es del modo ${modeBefore === "live" ? "real" : "de pruebas"}, y con él no se confirmaría ningún pago.`;
      }
      after = resolveStripeSettings(next.values, server, next.unreadable);
    }
    problem = problem ?? stripeConsistencyProblem(after, after.sources);

    const changed = fields.filter(
      (f) =>
        (next.values[f] ?? null) !== (current.values[f] ?? null) ||
        !!next.unreadable[f] !== !!current.unreadable[f],
    );
    return { before, after, next, problem, changed };
  }

  private readRow(
    row: {
      secretKeyEncrypted: string | null;
      publishableKey: string | null;
      webhookSecretEncrypted: string | null;
      otherWebhookSecretEncrypted: string | null;
    } | null,
  ): StoredState {
    const state: StoredState = { values: {}, unreadable: {} };
    if (!row) return state;
    const open = (field: StripeField, value: string | null, what: string) => {
      if (!value) return;
      try {
        state.values[field] = this.encryption.decrypt(value);
      } catch (err) {
        // The encryption key changed or the value is corrupt. Not the
        // .env's value instead: that could be the other mode's.
        state.unreadable[field] = true;
        this.logger.error(`Stored Stripe ${what} cannot be decrypted; Stripe is unconfigured until it is re-entered in the console: ${(err as Error).message}`);
      }
    };
    open("secretKey", row.secretKeyEncrypted, "secret key");
    state.values.publishableKey = row.publishableKey;
    open("webhookSecret", row.webhookSecretEncrypted, "webhook secret");
    open("otherWebhookSecret", row.otherWebhookSecretEncrypted, "other mode's webhook secret");
    return state;
  }

  private async reload(): Promise<void> {
    const row = await this.prisma.platformStripeConfig.findUnique({ where: { id: "global" } });
    this.stored = row ? { updatedAt: row.updatedAt, updatedBy: row.updatedBy } : null;
    const state = this.readRow(row);
    this.settings = resolveStripeSettings({ ...state.values, taxEnabled: row?.taxEnabled }, this.serverSettings(), state.unreadable);
    // The same checks as on saving: a mix the console would refuse (a key
    // that cannot be decrypted, a .env changed under the console's values)
    // is reported in the console in red, and logged.
    this.problem = stripeConsistencyProblem(this.settings, this.settings.sources);
    if (this.problem) this.logger.error(`Platform Stripe settings in force are inconsistent: ${this.problem}`);
    if (this.settings.taxIgnored) {
      this.logger.warn("Stripe Tax is switched on in the console or STRIPE_TAX_ENABLED, and ignored: KiraRoom charges no VAT (D6).");
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
