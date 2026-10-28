/**
 * The platform's email settings (Resend): which API key, sender and webhook
 * secret are in force, and where each one comes from. Pure, so it is tested
 * without a database (email-settings.spec.ts); PlatformEmailConfigService
 * loads the stored values and EmailService uses the result.
 *
 * Each setting comes from the platform console when set there, else from the
 * server's .env (RESEND_API_KEY, EMAIL_FROM, RESEND_WEBHOOK_SECRET), so a
 * server configured before the console existed keeps working.
 */

export type EmailSettingSource = "console" | "server" | "none";

export interface EmailSettings {
  apiKey: string | null;
  from: string | null;
  webhookSecret: string | null;
}

export interface EmailSettingsWithSources extends EmailSettings {
  sources: Record<keyof EmailSettings, EmailSettingSource>;
}

/** Empty strings count as unset, in the console and in .env alike. */
function present(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveEmailSettings(stored: Partial<EmailSettings>, server: Partial<EmailSettings>): EmailSettingsWithSources {
  const pick = (key: keyof EmailSettings): [string | null, EmailSettingSource] => {
    const fromConsole = present(stored[key]);
    if (fromConsole) return [fromConsole, "console"];
    const fromServer = present(server[key]);
    if (fromServer) return [fromServer, "server"];
    return [null, "none"];
  };
  const [apiKey, apiKeySource] = pick("apiKey");
  const [from, fromSource] = pick("from");
  const [webhookSecret, webhookSecretSource] = pick("webhookSecret");
  return {
    apiKey,
    from,
    webhookSecret,
    sources: { apiKey: apiKeySource, from: fromSource, webhookSecret: webhookSecretSource },
  };
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * "notificaciones@kiraroom.com" or "KiraRoom <notificaciones@kiraroom.com>":
 * the bare address and the display name, or null when it is neither.
 */
export function parseSender(from: string): { address: string; name: string | null } | null {
  const trimmed = from.trim();
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(trimmed);
  const address = (named ? named[2] : trimmed).trim();
  if (!ADDRESS.test(address)) return null;
  const name = named ? named[1].trim().replace(/^"(.*)"$/, "$1") || null : null;
  return { address, name };
}

/** The sender's domain, for the List-Unsubscribe mailto. */
export function senderDomain(from: string): string | null {
  const sender = parseSender(from);
  return sender ? sender.address.split("@")[1].toLowerCase() : null;
}

/** Why a value would not work, in Spanish for the console; null when it is fine. */
export function apiKeyProblem(key: string): string | null {
  return /^re_[A-Za-z0-9_-]{8,}$/.test(key.trim())
    ? null
    : "La clave de Resend empieza por «re_». Cópiala entera desde Resend → API Keys.";
}

export function webhookSecretProblem(secret: string): string | null {
  return /^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(secret.trim())
    ? null
    : "El secreto del webhook empieza por «whsec_». Está en Resend → Webhooks, en el webhook de KiraRoom.";
}

export function senderProblem(from: string): string | null {
  return parseSender(from)
    ? null
    : "Escribe una dirección, como notificaciones@kiraroom.com, o un nombre y la dirección: KiraRoom <notificaciones@kiraroom.com>.";
}

/** Last four characters of a secret, for the console to show which one is set. */
export function lastFour(secret: string | null): string | null {
  return secret && secret.length > 8 ? secret.slice(-4) : null;
}

/** Take any API key or webhook secret out of a provider's error before showing it. */
export function redactSecrets(message: string): string {
  return message.replace(/re_[A-Za-z0-9_-]{6,}/g, "re_***").replace(/whsec_[A-Za-z0-9+/=_-]{6,}/g, "whsec_***");
}
