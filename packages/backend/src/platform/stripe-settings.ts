/**
 * The platform's Stripe settings (KiraRoom's own account, which bills the
 * salons' subscriptions; a salon's own account for its clients is separate).
 * Pure, so it is tested without a database (stripe-settings.spec.ts);
 * PlatformStripeConfigService loads the stored values.
 *
 * Each setting comes from the platform console when set there, else from the
 * server's .env (STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY,
 * STRIPE_WEBHOOK_SECRET, STRIPE_TAX_ENABLED).
 */
import type { EmailSettingSource } from "./email-settings";

export type SettingSource = EmailSettingSource;
export type StripeMode = "test" | "live" | "none";

export interface StripeSettings {
  secretKey: string | null;
  publishableKey: string | null;
  webhookSecret: string | null;
  /** Stripe Tax on checkouts: Spanish VAT and the customer's tax id. */
  taxEnabled: boolean;
}

export interface StripeSettingsWithSources extends StripeSettings {
  sources: Record<keyof StripeSettings, SettingSource>;
}

export interface StoredStripeSettings {
  secretKey?: string | null;
  publishableKey?: string | null;
  webhookSecret?: string | null;
  taxEnabled?: boolean | null;
}

export interface ServerStripeSettings {
  secretKey?: string | null;
  publishableKey?: string | null;
  webhookSecret?: string | null;
  taxEnabled?: string | null;
}

function present(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** STRIPE_TAX_ENABLED accepts "true" or "1", as before. */
function envFlag(value: string | null | undefined): boolean | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return null;
  return v === "true" || v === "1";
}

export function resolveStripeSettings(stored: StoredStripeSettings, server: ServerStripeSettings): StripeSettingsWithSources {
  const pick = (key: "secretKey" | "publishableKey" | "webhookSecret"): [string | null, SettingSource] => {
    const fromConsole = present(stored[key]);
    if (fromConsole) return [fromConsole, "console"];
    const fromServer = present(server[key]);
    if (fromServer) return [fromServer, "server"];
    return [null, "none"];
  };
  const [secretKey, secretKeySource] = pick("secretKey");
  const [publishableKey, publishableKeySource] = pick("publishableKey");
  const [webhookSecret, webhookSecretSource] = pick("webhookSecret");

  let taxEnabled = false;
  let taxSource: SettingSource = "none";
  if (typeof stored.taxEnabled === "boolean") {
    taxEnabled = stored.taxEnabled;
    taxSource = "console";
  } else if (envFlag(server.taxEnabled) !== null) {
    taxEnabled = envFlag(server.taxEnabled)!;
    taxSource = "server";
  }

  return {
    secretKey,
    publishableKey,
    webhookSecret,
    taxEnabled,
    sources: {
      secretKey: secretKeySource,
      publishableKey: publishableKeySource,
      webhookSecret: webhookSecretSource,
      taxEnabled: taxSource,
    },
  };
}

/** Test or live, from a secret or publishable key's prefix. */
export function keyMode(key: string | null): StripeMode {
  if (!key) return "none";
  if (/^(sk|pk|rk)_test_/.test(key)) return "test";
  if (/^(sk|pk|rk)_live_/.test(key)) return "live";
  return "none";
}

/** Why a value would not work, in Spanish for the console; null when it is fine. */
export function secretKeyProblem(key: string): string | null {
  return /^sk_(test|live)_[A-Za-z0-9]{10,}$/.test(key.trim())
    ? null
    : "La clave secreta de Stripe empieza por «sk_test_» (pruebas) o «sk_live_» (real). Está en Stripe → Desarrolladores → Claves de API.";
}

export function publishableKeyProblem(key: string): string | null {
  return /^pk_(test|live)_[A-Za-z0-9]{10,}$/.test(key.trim())
    ? null
    : "La clave publicable de Stripe empieza por «pk_test_» o «pk_live_».";
}

export function stripeWebhookSecretProblem(secret: string): string | null {
  return /^whsec_[A-Za-z0-9]{10,}$/.test(secret.trim())
    ? null
    : "El secreto del webhook de Stripe empieza por «whsec_». Está en Stripe → Desarrolladores → Webhooks, en el de KiraRoom.";
}

/**
 * Whether the settings in force can take payments safely: a secret key needs
 * the webhook secret (without it no payment would ever activate an account,
 * and in production the webhook refuses unsigned events), and the two keys
 * must be from the same mode.
 */
export function stripeConsistencyProblem(s: StripeSettings): string | null {
  if (s.secretKey && !s.webhookSecret) {
    return "Con la clave secreta hace falta el secreto del webhook: sin él, Stripe no puede confirmar los pagos a KiraRoom.";
  }
  if (s.secretKey && s.publishableKey && keyMode(s.secretKey) !== keyMode(s.publishableKey)) {
    return "Las dos claves tienen que ser del mismo modo: las dos de pruebas (…_test_…) o las dos reales (…_live_…).";
  }
  return null;
}
