/**
 * What the platform console's Stripe page shows and sends. Pure, so it is
 * tested without the browser (platform-stripe.spec.ts).
 */
import type { PlatformStripeConfig, PlatformStripePreview, PlatformStripeUpdate, StripeMode } from "./api";

/** The six events KiraRoom handles on its own account's webhook. */
export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

export function modeName(mode: StripeMode): string {
  return mode === "live" ? "real" : mode === "test" ? "de pruebas" : "sin Stripe";
}

/** One line on top of the page: can KiraRoom charge, and for real? */
export function stripeStatus(cfg: PlatformStripeConfig): { tone: "ok" | "test" | "off"; text: string } {
  // The same check as on saving, for what is in force (a key that cannot
  // be decrypted, or a .env changed under the console's values).
  if (cfg.problem) return { tone: "off", text: cfg.problem };
  if (cfg.mode === "none") {
    return { tone: "off", text: "KiraRoom no puede cobrar: falta la clave secreta de Stripe." };
  }
  if (cfg.webhookSecret.source === "none") {
    return { tone: "off", text: "Falta el secreto del webhook: Stripe cobraría, pero KiraRoom no se enteraría de los pagos." };
  }
  if (cfg.mode === "test") {
    return { tone: "test", text: "Modo de pruebas: los pagos son simulados (tarjeta 4242 4242 4242 4242). KiraRoom no cobra IVA." };
  }
  return { tone: "ok", text: "Modo real: los salones pagan de verdad. KiraRoom no cobra IVA." };
}

export interface StripeForm {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  otherWebhookSecret: string;
}

/**
 * The request for "Guardar": typed secrets replace the stored ones (blank
 * keeps them; they are never shown back); the publishable key is sent only
 * when it changed. Null for nothing to save.
 */
export function stripeUpdate(form: StripeForm, cfg: PlatformStripeConfig): PlatformStripeUpdate | null {
  const out: PlatformStripeUpdate = {};
  if (form.secretKey.trim()) out.secretKey = form.secretKey.trim();
  if (form.webhookSecret.trim()) out.webhookSecret = form.webhookSecret.trim();
  if (form.otherWebhookSecret.trim()) out.otherWebhookSecret = form.otherWebhookSecret.trim();
  const pk = form.publishableKey.trim();
  if (pk && pk !== (cfg.publishableKey.value ?? "")) out.publishableKey = pk;
  return Object.keys(out).length > 0 ? out : null;
}

/** "Volver a lo del servidor (.env)": the three console fields cleared at once. */
export const BACK_TO_SERVER: PlatformStripeUpdate = { secretKey: null, publishableKey: null, webhookSecret: null };

/** Whether anything of the three is set in the console (else the button has nothing to do). */
export function hasConsoleKeys(cfg: PlatformStripeConfig): boolean {
  return [cfg.secretKey.source, cfg.publishableKey.source, cfg.webhookSecret.source].some(
    (s) => s === "console" || s === "unreadable",
  );
}

/**
 * The confirmation before saving: which mode will result, and on a mode
 * change the salons with the other mode's data. Null when no confirmation
 * is needed (the mode does not change).
 */
export function previewWarning(p: PlatformStripePreview): { title: string; lines: string[]; destructive: boolean } | null {
  if (p.modeAfter === p.modeBefore) return null;
  const lines: string[] = [];
  if (p.modeAfter === "live") {
    lines.push("Pasarás a modo REAL: los salones pagarán de verdad con sus tarjetas.");
  } else if (p.modeAfter === "test") {
    lines.push("Pasarás a modo DE PRUEBAS: los pagos serán simulados y nadie pagará de verdad, aunque los planes se activen.");
  } else {
    lines.push("KiraRoom dejará de poder cobrar: no quedará ninguna clave secreta de Stripe.");
  }
  if (p.impact) {
    const other = modeName(p.modeAfter === "live" ? "test" : "live");
    lines.push(
      p.impact.otherModeSalons === 0
        ? `Ningún salón tiene cliente ni suscripción de Stripe en modo ${other}.`
        : `${p.impact.otherModeSalons} salón(es) tienen cliente o suscripción de Stripe en modo ${other}: al pagar se les creará uno nuevo, y su suscripción anterior ya no se podrá gestionar desde KiraRoom.`,
    );
    if (p.impact.activePlansTotal > 0) {
      const names = p.impact.activePlans.map((t) => `${t.name}${t.plan ? ` (${t.plan})` : ""}`).join(", ");
      const more = p.impact.activePlansTotal > p.impact.activePlans.length ? "…" : "";
      lines.push(
        `${p.impact.activePlansTotal} plan(es) activo(s) se pagaron en modo ${other} y seguirán activos hasta que los revises: ${names}${more}.`,
      );
    }
  }
  return {
    title: `¿Pasar Stripe a modo ${modeName(p.modeAfter)}?`,
    lines,
    destructive: p.modeAfter !== "test",
  };
}
