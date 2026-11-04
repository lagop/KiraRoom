import type { PrismaService } from "../common/prisma/prisma.service";

/**
 * Salons that share a phone or a fiscal NIF with another salon (D9): for
 * the SaaS console only, as a hint of a second free trial or a duplicate
 * account. Information, never a block: two salons of one owner, or a
 * franchise, share them legitimately.
 */
export interface SharedIdentityWarning {
  kind: "phone" | "taxId";
  /** The shared value as stored on this salon. */
  value: string;
  others: { id: string; name: string; slug: string }[];
}

export interface IdentityRow {
  id: string;
  name: string;
  slug: string;
  /** The salon's phone and its owner's (the signup asks the owner for one). */
  phones: (string | null)[];
  taxId: string | null;
}

/** Digits only, without the Spanish prefix: "+34 600 11 22 33" and "600112233" are one phone. */
export function normalizePhone(phone: string | null | undefined): string | null {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("0034")) digits = digits.slice(4);
  else if (digits.length === 11 && digits.startsWith("34")) digits = digits.slice(2);
  return digits.length >= 9 ? digits : null;
}

/** Capitals, letters and digits only: "b-1234567.4" and "B12345674" are one NIF. */
export function normalizeTaxId(taxId: string | null | undefined): string | null {
  const v = String(taxId ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return v.length >= 8 ? v : null;
}

/** For each of `ids`, the other salons among `rows` that share its phone or NIF. */
export function sharedIdentityWarnings(
  rows: IdentityRow[],
  ids: string[],
): Map<string, SharedIdentityWarning[]> {
  const byKey = new Map<string, IdentityRow[]>();
  const keysOf = (r: IdentityRow) => {
    const keys: { kind: SharedIdentityWarning["kind"]; key: string; value: string }[] = [];
    const seen = new Set<string>();
    for (const raw of r.phones) {
      const phone = normalizePhone(raw);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      keys.push({ kind: "phone", key: `phone:${phone}`, value: raw! });
    }
    const taxId = normalizeTaxId(r.taxId);
    if (taxId) keys.push({ kind: "taxId", key: `taxId:${taxId}`, value: r.taxId! });
    return keys;
  };
  for (const r of rows) {
    for (const k of keysOf(r)) {
      const list = byKey.get(k.key) ?? [];
      list.push(r);
      byKey.set(k.key, list);
    }
  }

  const out = new Map<string, SharedIdentityWarning[]>();
  for (const id of ids) {
    const row = rows.find((r) => r.id === id);
    if (!row) continue;
    const warnings: SharedIdentityWarning[] = [];
    for (const k of keysOf(row)) {
      const others = (byKey.get(k.key) ?? [])
        .filter((o) => o.id !== id)
        .map((o) => ({ id: o.id, name: o.name, slug: o.slug }));
      if (others.length > 0) warnings.push({ kind: k.kind, value: k.value, others });
    }
    if (warnings.length > 0) out.set(id, warnings);
  }
  return out;
}

/**
 * Loads the salons with a phone or a NIF and returns the warnings for
 * `ids`. Normalised in memory (stored phones come in every format), which
 * reads every salon's two fields: fine at the console's scale. Deleted
 * salons are left out; if this query fails the console still loads.
 */
export async function loadSharedIdentityWarnings(
  prisma: Pick<PrismaService, "tenant">,
  ids: string[],
): Promise<Map<string, SharedIdentityWarning[]>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.tenant.findMany({
    where: {
      deletedAt: null,
      OR: [
        { phone: { not: null } },
        { taxId: { not: null } },
        { users: { some: { role: "owner", phone: { not: null } } } },
      ],
    },
    select: {
      id: true,
      name: true,
      slug: true,
      phone: true,
      taxId: true,
      users: { where: { role: "owner" }, select: { phone: true } },
    },
  });
  return sharedIdentityWarnings(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      phones: [r.phone, ...(r.users ?? []).map((u) => u.phone)],
      taxId: r.taxId,
    })),
    ids,
  );
}
