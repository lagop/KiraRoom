/**
 * The SaaS console's warning when salons share a phone or a fiscal NIF
 * (D9): a hint of a second free trial or a duplicate account. Information
 * only, nothing is blocked. Pure, tested in shared-identity.spec.ts.
 */
export interface SharedIdentityWarning {
  kind: "phone" | "taxId";
  value: string;
  others: { id: string; name: string; slug: string }[];
}

const LABEL: Record<SharedIdentityWarning["kind"], string> = {
  phone: "el teléfono",
  taxId: "el NIF",
};

/** "Comparte el teléfono 600 11 22 33 con: Pelu Ana, Pelu Ana 2." */
export function sharedIdentityLine(w: SharedIdentityWarning): string {
  return `Comparte ${LABEL[w.kind]} ${w.value} con: ${w.others.map((o) => o.name).join(", ")}.`;
}

/** The short badge of the tenants list, or null without warnings. */
export function sharedIdentityBadge(warnings: SharedIdentityWarning[] | null | undefined): string | null {
  if (!warnings || warnings.length === 0) return null;
  const kinds = new Set(warnings.map((w) => w.kind));
  if (kinds.size === 2) return "Teléfono y NIF compartidos";
  return kinds.has("phone") ? "Teléfono compartido" : "NIF compartido";
}
