/**
 * The platform's Stripe settings (KiraRoom's own account, which bills the
 * salons' subscriptions; a salon's own account for its clients is separate).
 * Pure, so it is tested without a database (stripe-settings.spec.ts);
 * PlatformStripeConfigService loads the stored values.
 *
 * Each setting comes from the platform console when set there, else from the
 * server's .env (STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY,
 * STRIPE_WEBHOOK_SECRET). The secret key and the webhook secret always come
 * from the same place (stripeConsistencyProblem): a key of one mode with the
 * webhook secret of the other would leave every payment unconfirmed.
 *
 * Stripe Tax is always off: KiraRoom charges no VAT or IGIC on its plans
 * (owner's decision D6, 2026-11-04). A stored or .env STRIPE_TAX_ENABLED is
 * ignored and reported as `taxIgnored`.
 */
import type { EmailSettingSource } from "./email-settings";

export type SettingSource = EmailSettingSource;
export type StripeMode = "test" | "live" | "none";

export interface StripeSettings {
  secretKey: string | null;
  publishableKey: string | null;
  /** The webhook secret of the secret key's mode. */
  webhookSecret: string | null;
  /**
   * The webhook secret of the OTHER mode (optional). Stripe signs test and
   * live events with different secrets; with this one, the other mode's
   * events (retries after a switch, renewals of old subscriptions) are
   * verified and acknowledged without being applied, instead of failing
   * with a 400 until Stripe disables the endpoint.
   */
  otherWebhookSecret: string | null;
  /** Always false (D6). Kept so the checkout code keeps its switch. */
  taxEnabled: boolean;
}

export type StripeField = "secretKey" | "publishableKey" | "webhookSecret" | "otherWebhookSecret";

export interface StripeSettingsWithSources extends StripeSettings {
  sources: Record<StripeField, SettingSource>;
  /** Stripe Tax was asked for (console or STRIPE_TAX_ENABLED) and is ignored. */
  taxIgnored: boolean;
}

export interface StoredStripeSettings {
  secretKey?: string | null;
  publishableKey?: string | null;
  webhookSecret?: string | null;
  otherWebhookSecret?: string | null;
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
function envFlag(value: string | null | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * `unreadable` marks the console values that are stored but cannot be
 * decrypted: such a setting counts as not configured ("unreadable"), never
 * as the .env's.
 */
export function resolveStripeSettings(
  stored: StoredStripeSettings,
  server: ServerStripeSettings,
  unreadable: Partial<Record<StripeField, boolean>> = {},
): StripeSettingsWithSources {
  const pick = (key: "secretKey" | "publishableKey" | "webhookSecret"): [string | null, SettingSource] => {
    if (unreadable[key]) return [null, "unreadable"];
    const fromConsole = present(stored[key]);
    if (fromConsole) return [fromConsole, "console"];
    const fromServer = present(server[key]);
    if (fromServer) return [fromServer, "server"];
    return [null, "none"];
  };
  const [secretKey, secretKeySource] = pick("secretKey");
  const [publishableKey, publishableKeySource] = pick("publishableKey");
  const [webhookSecret, webhookSecretSource] = pick("webhookSecret");

  // The other mode's secret: the console's, else the .env's when the .env
  // holds the other mode's pair (console keys of one mode over .env keys of
  // the other, as production had).
  let otherWebhookSecret: string | null = null;
  let otherSource: SettingSource = "none";
  const active = keyMode(secretKey);
  if (unreadable.otherWebhookSecret) {
    otherSource = "unreadable";
  } else if (present(stored.otherWebhookSecret)) {
    otherWebhookSecret = present(stored.otherWebhookSecret);
    otherSource = "console";
  } else {
    const serverMode = keyMode(present(server.secretKey));
    const serverSecret = present(server.webhookSecret);
    if (serverSecret && webhookSecretSource !== "server" && active !== "none" && serverMode !== "none" && serverMode !== active) {
      otherWebhookSecret = serverSecret;
      otherSource = "server";
    }
  }

  return {
    secretKey,
    publishableKey,
    webhookSecret,
    otherWebhookSecret,
    taxEnabled: false,
    taxIgnored: stored.taxEnabled === true || (typeof stored.taxEnabled !== "boolean" && envFlag(server.taxEnabled)),
    sources: {
      secretKey: secretKeySource,
      publishableKey: publishableKeySource,
      webhookSecret: webhookSecretSource,
      otherWebhookSecret: otherSource,
    },
  };
}

/** Test or live, from a secret or publishable key's prefix. */
export function keyMode(key: string | null | undefined): StripeMode {
  if (!key) return "none";
  if (/^(sk|pk|rk)_test_/.test(key)) return "test";
  if (/^(sk|pk|rk)_live_/.test(key)) return "live";
  return "none";
}

/** The opposite mode ("none" stays "none"). */
export function otherMode(mode: StripeMode): StripeMode {
  return mode === "test" ? "live" : mode === "live" ? "test" : "none";
}

/** Stripe's `livemode` for a mode: null when there is no key. */
export function livemodeOf(mode: StripeMode): boolean | null {
  return mode === "none" ? null : mode === "live";
}

/**
 * Whether a customer or subscription created in `storedLivemode` exists for
 * the keys in force. Unknown (null: created before modes were recorded, or
 * without keys) and no keys count as the same mode, as before.
 */
export function sameStripeMode(storedLivemode: boolean | null | undefined, activeLivemode: boolean | null): boolean {
  if (storedLivemode === null || storedLivemode === undefined || activeLivemode === null) return true;
  return storedLivemode === activeLivemode;
}

/**
 * Audit 8 D8: while the platform's Stripe keys are test keys nothing is
 * charged, so a real salon must not "contract" anything that would look
 * paid: checkout, plan or location changes, add-ons and packs are refused.
 * KiraRoom's own salons (Tenant.isInternal) may still try every flow.
 * Nothing changes with live keys, or without keys (Stripe not configured
 * is handled where it was).
 */
export const TEST_MODE_PAYMENTS_REFUSED =
  "Los pagos de KiraRoom están en modo de pruebas: no se cobra nada, y por eso todavía no se puede contratar ni cambiar el plan, los complementos ni los bonos.";

export function paymentsTestMode(activeLivemode: boolean | null): boolean {
  return activeLivemode === false;
}

export function testModeRefusesPayment(
  activeLivemode: boolean | null,
  tenant: { isInternal?: boolean | null },
): boolean {
  return paymentsTestMode(activeLivemode) && tenant.isInternal !== true;
}

/**
 * The webhook secrets to verify an event with, the one of the event's mode
 * first. `livemode` is read from the unverified payload only to pick the
 * order; the verified event's own livemode decides what is applied.
 */
export function webhookSecretsFor(s: StripeSettings, livemode: boolean | null): string[] {
  const active = keyMode(s.secretKey);
  const eventMode: StripeMode = livemode === null ? "none" : livemode ? "live" : "test";
  const ordered =
    active !== "none" && eventMode !== "none" && eventMode !== active
      ? [s.otherWebhookSecret, s.webhookSecret]
      : [s.webhookSecret, s.otherWebhookSecret];
  return ordered.filter((v, i, all): v is string => !!v && all.indexOf(v) === i);
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

const FIELD_NAMES: Record<StripeField, string> = {
  secretKey: "la clave secreta",
  publishableKey: "la clave publicable",
  webhookSecret: "el secreto del webhook",
  otherWebhookSecret: "el secreto del webhook del otro modo",
};

/**
 * Whether the settings in force can take payments safely:
 * - no stored value that cannot be decrypted;
 * - a secret key needs the webhook secret (without it no payment would ever
 *   activate an account, and in production the webhook refuses unsigned
 *   events), both from the same place (console or .env), so that they are
 *   of the same mode;
 * - both keys from the same mode.
 * `sources` is optional so the pure checks can run on bare settings.
 */
export function stripeConsistencyProblem(s: StripeSettings, sources?: Partial<Record<StripeField, SettingSource>>): string | null {
  if (sources) {
    const unreadable = (["secretKey", "publishableKey", "webhookSecret"] as StripeField[]).find((f) => sources[f] === "unreadable");
    if (!unreadable && sources.otherWebhookSecret === "unreadable") {
      return "No se puede descifrar el secreto del webhook del otro modo guardado en la consola (¿ha cambiado META_TOKEN_ENCRYPTION_KEY?). Los pagos siguen funcionando, pero los avisos del otro modo fallarán: vuelve a escribirlo o quítalo.";
    }
    if (unreadable) {
      return `No se puede descifrar lo que hay guardado en la consola como ${FIELD_NAMES[unreadable]} (¿ha cambiado META_TOKEN_ENCRYPTION_KEY?), así que Stripe queda sin configurar. Vuelve a escribir ese valor aquí, o vuelve a lo del servidor (.env).`;
    }
  }
  if (s.secretKey && !s.webhookSecret) {
    return "Con la clave secreta hace falta el secreto del webhook: sin él, Stripe no puede confirmar los pagos a KiraRoom.";
  }
  if (sources && s.secretKey && sources.secretKey && sources.webhookSecret && sources.secretKey !== sources.webhookSecret) {
    return "La clave secreta y el secreto del webhook tienen que venir del mismo sitio: los dos de la consola o los dos del servidor (.env). Si no, la clave sería de un modo y el secreto del webhook de otro, y no se confirmaría ningún pago.";
  }
  if (s.secretKey && s.publishableKey && keyMode(s.secretKey) !== keyMode(s.publishableKey)) {
    return "Las dos claves tienen que ser del mismo modo: las dos de pruebas (…_test_…) o las dos reales (…_live_…).";
  }
  if (s.webhookSecret && s.otherWebhookSecret && s.webhookSecret === s.otherWebhookSecret) {
    return "El secreto del webhook del otro modo no puede ser el mismo que el del modo en uso: cada webhook de Stripe tiene el suyo.";
  }
  return null;
}
