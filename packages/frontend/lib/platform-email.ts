/**
 * What the platform console's Email page shows and sends. Pure, so it is
 * tested without the browser (platform-email.spec.ts).
 */
import type { EmailSettingSource, PlatformEmailConfig } from "./api";

export function sourceText(source: EmailSettingSource): string {
  switch (source) {
    case "console":
      return "Configurada aquí";
    case "server":
      return "Del servidor (.env)";
    default:
      return "Sin configurar";
  }
}

/** One line on top of the page: can KiraRoom send email, and track it? */
export function emailStatus(cfg: PlatformEmailConfig): { ok: boolean; text: string } {
  if (cfg.apiKey.source === "none") {
    return { ok: false, text: "No sale ningún email: falta la clave de Resend." };
  }
  if (cfg.from.source === "none") {
    return { ok: false, text: "Falta la dirección de envío: sin ella Resend rechaza los emails." };
  }
  if (cfg.webhookSecret.source === "none") {
    return {
      ok: true,
      text: "Los emails salen. Falta el secreto del webhook: las campañas no sabrán qué se entregó, en qué se hizo clic o qué rebotó.",
    };
  }
  return { ok: true, text: "Los emails salen y se registran entregas, clics y rebotes (las aperturas no se usan)." };
}

/** What the console says about Resend's open tracking: it is not used, and should be off. */
export const OPEN_TRACKING_NOTE =
  "KiraRoom no usa las aperturas (el píxel de seguimiento lee el dispositivo de la clienta y además falla con Apple Mail): " +
  "solo cuenta entregas, clics y rebotes, y descarta los avisos de apertura. Desactiva «Open tracking» en Resend → Domains → " +
  "tu dominio → Configuration, y deja «Click tracking» activado.";

export interface PackForm {
  /** Emails in the bono, as typed. */
  emails: string;
  /** Its price in euros before VAT, as typed ("15" or "15,50"). */
  price: string;
}

/** The form's starting values: what is saved, or empty. */
export function packForm(cfg: PlatformEmailConfig): PackForm {
  const { emails, priceCents } = cfg.marketingPack ?? { emails: null, priceCents: null };
  return {
    emails: emails ? String(emails) : "",
    price: priceCents ? (priceCents / 100).toFixed(2).replace(".", ",") : "",
  };
}

/**
 * The request for "Guardar bono": both values, or an error in Spanish. Euros
 * are typed the Spanish way and sent in cents.
 */
export function packUpdate(
  form: PackForm,
): { ok: true; value: { marketingPackEmails: number; marketingPackPriceCents: number } } | { ok: false; error: string } {
  const emails = Number(form.emails.trim().replace(/\./g, ""));
  if (!Number.isInteger(emails) || emails < 100 || emails > 100000) {
    return { ok: false, error: "El bono debe tener entre 100 y 100.000 emails." };
  }
  const priceText = form.price.trim().replace(/\s|€/g, "").replace(",", ".");
  const price = Number(priceText);
  if (!priceText || !Number.isFinite(price) || price < 0.5 || price > 10000) {
    return { ok: false, error: "Pon un precio entre 0,50 € y 10.000 €, sin IVA." };
  }
  return { ok: true, value: { marketingPackEmails: emails, marketingPackPriceCents: Math.round(price * 100) } };
}

export interface EmailForm {
  apiKey: string;
  from: string;
  webhookSecret: string;
}

/**
 * The request for "Guardar": a typed key or secret replaces the stored one
 * (blank keeps it, they are never shown back); the sender is sent only when
 * it changed. Null for nothing to save.
 */
export function emailUpdate(
  form: EmailForm,
  cfg: PlatformEmailConfig,
): { apiKey?: string; from?: string; webhookSecret?: string } | null {
  const out: { apiKey?: string; from?: string; webhookSecret?: string } = {};
  if (form.apiKey.trim()) out.apiKey = form.apiKey.trim();
  if (form.webhookSecret.trim()) out.webhookSecret = form.webhookSecret.trim();
  const from = form.from.trim();
  if (from && from !== (cfg.from.value ?? "")) out.from = from;
  return Object.keys(out).length > 0 ? out : null;
}
