/**
 * What the dashboard says while a salon is read-only (trial ended without a
 * plan, subscription cancelled or suspended), or null when it says nothing.
 * Pure, so the rule is tested without React: see ReadOnlyBanner.
 */
export interface ReadOnlyNotice {
  title: string;
  body: string;
  cta: string;
}

export function readOnlyNotice(ctx: {
  confirmed: boolean;
  subscriptionStatus: string;
  readOnlyUntil: string | null;
}): ReadOnlyNotice | null {
  // Before the server answers, the status is the token's fallback
  // ("cancelled"): a paying salon must never see the notice flash.
  if (!ctx.confirmed) return null;
  const status = ctx.subscriptionStatus;
  if (status !== "cancelled" && status !== "suspended") return null;

  const suspended = status === "suspended";
  const until = ctx.readOnlyUntil
    ? new Date(ctx.readOnlyUntil).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" })
    : null;

  return {
    title: suspended
      ? "Tu suscripción está suspendida por un pago pendiente."
      : "Tu cuenta está en modo solo lectura.",
    body:
      "Puedes consultar y exportar tus datos, pero no crear ni cambiar citas, clientas ni servicios, y tu página no acepta reservas." +
      (until ? ` Tus datos se conservan hasta el ${until}.` : ""),
    cta: suspended ? "Actualizar el pago" : "Elegir un plan",
  };
}
