/**
 * "Fusionar con otra clienta" on the client file: what the two records look
 * like side by side and what the kept one will have afterwards. The server
 * (POST /admin/clients/:id/merge) does the merge; this only previews it the
 * same way: the kept record's details stay, an empty one is taken from the
 * other record, visits add up, and the other record is deleted.
 */

export interface MergeSide {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  taxId?: string | null;
  status: "active" | "inactive" | "blocked" | string;
  createdAt?: string | null;
  /** From the list (GET /admin/clients). */
  _count?: { appointments: number };
  /** From the client file (GET /clients/:id), capped at 100. */
  appointments?: unknown[];
}

export interface MergePreviewRow {
  label: string;
  kept: string;
  other: string;
  result: string;
  /** The kept record had nothing here and takes the other's. */
  filled: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  active: "Activa",
  inactive: "Desactivada",
  blocked: "Bloqueada",
};

const EMPTY = "—";

function text(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : "";
}

function appointmentsOf(side: MergeSide): number {
  return side._count?.appointments ?? side.appointments?.length ?? 0;
}

function day(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("es-ES", { year: "numeric", month: "short", day: "numeric" });
}

export function fullName(side: Pick<MergeSide, "firstName" | "lastName">): string {
  return `${side.firstName ?? ""} ${side.lastName ?? ""}`.trim();
}

/** The rows of the side-by-side table. */
export function mergePreviewRows(kept: MergeSide, other: MergeSide): MergePreviewRow[] {
  const fillable = (label: string, a: string, b: string): MergePreviewRow => ({
    label,
    kept: a || EMPTY,
    other: b || EMPTY,
    result: a || b || EMPTY,
    filled: !a && !!b,
  });
  const keptSince = kept.createdAt ?? null;
  const otherSince = other.createdAt ?? null;
  const since =
    keptSince && otherSince ? (new Date(otherSince) < new Date(keptSince) ? otherSince : keptSince) : keptSince ?? otherSince;
  return [
    { label: "Nombre", kept: fullName(kept), other: fullName(other), result: fullName(kept), filled: false },
    fillable("Email", text(kept.email), text(other.email).toLowerCase()),
    fillable("Teléfono", text(kept.phone), text(other.phone)),
    fillable("NIF / documento", text(kept.taxId), text(other.taxId)),
    {
      label: "Estado",
      kept: STATUS_LABEL[kept.status] ?? kept.status,
      other: STATUS_LABEL[other.status] ?? other.status,
      result: STATUS_LABEL[kept.status] ?? kept.status,
      filled: false,
    },
    {
      label: "Citas",
      kept: String(appointmentsOf(kept)),
      other: String(appointmentsOf(other)),
      result: String(appointmentsOf(kept) + appointmentsOf(other)),
      filled: false,
    },
    { label: "Clienta desde", kept: day(keptSince) || EMPTY, other: day(otherSince) || EMPTY, result: day(since) || EMPTY, filled: false },
  ];
}

/**
 * Why the server would refuse this merge, in the words it uses, or null.
 * Shown before asking for confirmation, with the way out (swap the sides).
 */
export function mergeRefusal(kept: MergeSide, other: MergeSide): string | null {
  if (kept.id === other.id) return "Es la misma ficha.";
  // As the server's client-anonymize.ts leaves a record.
  if ([kept, other].some((s) => s.status === "inactive" && s.firstName === "Clienta" && s.lastName === "anonimizada")) {
    return "Una ficha anonimizada (RGPD) no se puede fusionar: sus datos se borraron a petición de la clienta.";
  }
  if (kept.status === "inactive") {
    return "La ficha que se conserva está desactivada. Conserva la otra (Intercambiar) o actívala antes.";
  }
  if (other.status === "blocked" && kept.status !== "blocked") {
    return "La ficha que se eliminaría está bloqueada y la que se conserva no: el bloqueo se perdería. Conserva la bloqueada (Intercambiar) o desbloquéala antes.";
  }
  return null;
}
