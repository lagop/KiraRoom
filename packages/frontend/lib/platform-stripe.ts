/**
 * What the platform console's Stripe page shows and sends. Pure, so it is
 * tested without the browser (platform-stripe.spec.ts).
 */
import type { PlatformStripeConfig } from "./api";

/** The six events KiraRoom handles on its own account's webhook. */
export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

/** One line on top of the page: can KiraRoom charge, and for real? */
export function stripeStatus(cfg: PlatformStripeConfig): { tone: "ok" | "test" | "off"; text: string } {
  if (cfg.mode === "none") {
    return { tone: "off", text: "KiraRoom no puede cobrar: falta la clave secreta de Stripe." };
  }
  if (cfg.webhookSecret.source === "none") {
    return { tone: "off", text: "Falta el secreto del webhook: Stripe cobraría, pero KiraRoom no se enteraría de los pagos." };
  }
  const tax = cfg.taxEnabled.value ? " IVA con Stripe Tax activado." : " IVA sin activar.";
  if (cfg.mode === "test") {
    return { tone: "test", text: `Modo de pruebas: los pagos son simulados (tarjeta 4242 4242 4242 4242).${tax}` };
  }
  return { tone: "ok", text: `Modo real: los salones pagan de verdad.${tax}` };
}

export interface StripeForm {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  taxEnabled: boolean;
}

/**
 * The request for "Guardar": typed secrets replace the stored ones (blank
 * keeps them; they are never shown back); the publishable key and the tax
 * switch are sent only when they changed. Null for nothing to save.
 */
export function stripeUpdate(
  form: StripeForm,
  cfg: PlatformStripeConfig,
): { secretKey?: string; publishableKey?: string; webhookSecret?: string; taxEnabled?: boolean } | null {
  const out: { secretKey?: string; publishableKey?: string; webhookSecret?: string; taxEnabled?: boolean } = {};
  if (form.secretKey.trim()) out.secretKey = form.secretKey.trim();
  if (form.webhookSecret.trim()) out.webhookSecret = form.webhookSecret.trim();
  const pk = form.publishableKey.trim();
  if (pk && pk !== (cfg.publishableKey.value ?? "")) out.publishableKey = pk;
  if (form.taxEnabled !== cfg.taxEnabled.value) out.taxEnabled = form.taxEnabled;
  return Object.keys(out).length > 0 ? out : null;
}
