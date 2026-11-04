import type { Prisma } from "@prisma/client";

/**
 * Audit 8, C15: anonymising a salon keeps its audit-log rows (who did what,
 * when: the trail itself) but takes the personal data out of them: emails,
 * names, phones, addresses, NIFs. Rows written before the owner's email
 * stopped being copied into `saas.impersonate` still have it, and a
 * `tenant.update` row keeps the before/after of the fields it changed.
 */
export const AUDIT_ANON = "[anonymized]";

/** Metadata keys whose value is personal data, whatever it is. */
const PII_KEY = /(e-?mail|^to$|name|phone|whatsapp|street|address|city|postal|taxid|nif|legal|website|instagram|facebook|^ip)/i;

/** Rows whose before/after are themselves the personal value (the NIF). */
const VALUE_ACTIONS = new Set(["tenant.taxId.change"]);

function scrubValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.includes("@") ? AUDIT_ANON : value;
  if (Array.isArray(value)) return value.map(scrubValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = PII_KEY.test(k) && v !== null && v !== undefined ? AUDIT_ANON : scrubValue(v);
    }
    return out;
  }
  return value;
}

/** The row's metadata with its personal data replaced; ids, amounts and dates stay. */
export function scrubAuditMetadata(action: string, metadata: unknown, opts: { keepFiscalData?: boolean } = {}): unknown {
  // The retention job keeps the salon's NIF (fiscal record); its change rows keep it too.
  if (opts.keepFiscalData && VALUE_ACTIONS.has(action)) return metadata;
  const scrubbed = scrubValue(metadata);
  if (VALUE_ACTIONS.has(action) && scrubbed && typeof scrubbed === "object" && !Array.isArray(scrubbed)) {
    const m = { ...(scrubbed as Record<string, unknown>) };
    if (m.before != null) m.before = AUDIT_ANON;
    if (m.after != null) m.after = AUDIT_ANON;
    return m;
  }
  return scrubbed;
}

/**
 * Scrubs every audit row of this salon: the ones written for it, and its
 * invitation's rows, which are written before the salon exists (no tenantId,
 * the invite id in the metadata). Returns how many rows changed.
 */
export async function scrubTenantAuditLogs(
  tx: Prisma.TransactionClient,
  tenantId: string,
  opts: { keepFiscalData?: boolean } = {},
): Promise<number> {
  const invites = await tx.tenantInvite.findMany({ where: { tenantId }, select: { id: true } });
  const inviteIds = invites.map((i) => i.id);
  const rows = await tx.auditLog.findMany({
    where: {
      OR: [
        { tenantId },
        ...inviteIds.map((id) => ({ tenantId: null, metadata: { path: ["inviteId"], equals: id } })),
      ],
    },
    select: { id: true, action: true, metadata: true },
  });
  let changed = 0;
  for (const row of rows) {
    const next = scrubAuditMetadata(row.action, row.metadata, opts);
    if (JSON.stringify(next) === JSON.stringify(row.metadata)) continue;
    await tx.auditLog.update({ where: { id: row.id }, data: { metadata: next as Prisma.InputJsonValue } });
    changed++;
  }
  return changed;
}
