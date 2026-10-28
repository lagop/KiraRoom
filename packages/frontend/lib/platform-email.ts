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
      text: "Los emails salen. Falta el secreto del webhook: las campañas no sabrán qué se entregó, abrió o rebotó.",
    };
  }
  return { ok: true, text: "Los emails salen y se registran entregas, aperturas y rebotes." };
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
