/**
 * What the dashboard says while a salon is read-only (trial ended without a
 * plan, subscription cancelled or suspended), or null when it says nothing.
 * Pure, so the rule is tested without React: see ReadOnlyBanner.
 */
export interface ReadOnlyNotice {
  title: string;
  body: string;
  /** The button to Facturación; null for whoever cannot pay (only the owner can). */
  cta: string | null;
}

/** Who can choose a plan or fix the payment: Facturación is the owner's only. */
export function canManageBilling(role: string | null | undefined): boolean {
  return role === "owner" || role === "saas_owner";
}

export function readOnlyNotice(ctx: {
  confirmed: boolean;
  subscriptionStatus: string;
  readOnlyUntil: string | null;
  /** Defaults to true. Admins and staff are told to ask the owner instead. */
  canManageBilling?: boolean;
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

  const owner = ctx.canManageBilling ?? true;
  return {
    title: suspended
      ? "Tu suscripción está suspendida por un pago pendiente."
      : "Tu cuenta está en modo solo lectura.",
    body:
      "Puedes consultar y exportar tus datos, pero no crear ni cambiar citas, clientas ni servicios, y tu página no acepta reservas." +
      // The same period as the terms and the emails (audit 7 D7).
      (until ? ` Puedes exportarlos hasta el ${until}; después se anonimizan.` : "") +
      (owner
        ? ""
        : suspended
          ? " Pide a la dueña del salón que actualice el pago."
          : " Pide a la dueña del salón que elija un plan."),
    cta: owner ? (suspended ? "Actualizar el pago" : "Elegir un plan") : null,
  };
}
