/** Display helpers for the console's audit-log page (audit 8, C9). */

/** The translation key of an action's label: "tenant.taxId.change" -> "saas.audit.actions.tenant_taxId_change". */
export function auditActionKey(action: string): string {
  return `saas.audit.actions.${action.replace(/[^A-Za-z0-9]+/g, "_")}`;
}

/** "Ana López (ana@x.es)", or the email alone, or a dash. */
export function auditPersonLabel(
  person: { email?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined,
): string {
  if (!person) return "—";
  const name = [person.firstName, person.lastName].filter((p) => p && p.trim()).join(" ").trim();
  if (name && person.email) return `${name} (${person.email})`;
  return name || person.email || "—";
}
