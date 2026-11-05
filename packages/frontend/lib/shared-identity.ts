/**
 * The SaaS console's warning when salons share a phone or a fiscal NIF
 * (D9): a hint of a second free trial or a duplicate account. Information
 * only, nothing is blocked. Pure, tested in saas-tenant.spec.ts.
 */
export interface SharedIdentityWarning {
  kind: "phone" | "taxId";
  value: string;
  /** deleted: a salon removed from the console still counts (a second trial after deleting, audit 8 T23). */
  others: { id: string; name: string; slug: string; deleted?: boolean }[];
}

const LABEL: Record<SharedIdentityWarning["kind"], string> = {
  phone: "el teléfono",
  taxId: "el NIF",
};

/** "Comparte el teléfono 600 11 22 33 con: Pelu Ana, Pelu Ana 2 (eliminado)." */
export function sharedIdentityLine(w: SharedIdentityWarning): string {
  const names = w.others.map((o) => (o.deleted ? `${o.name} (eliminado)` : o.name));
  return `Comparte ${LABEL[w.kind]} ${w.value} con: ${names.join(", ")}.`;
}

/** The short badge of the tenants list, or null without warnings. */
export function sharedIdentityBadge(warnings: SharedIdentityWarning[] | null | undefined): string | null {
  if (!warnings || warnings.length === 0) return null;
  const kinds = new Set(warnings.map((w) => w.kind));
  if (kinds.size === 2) return "Teléfono y NIF compartidos";
  return kinds.has("phone") ? "Teléfono compartido" : "NIF compartido";
}
