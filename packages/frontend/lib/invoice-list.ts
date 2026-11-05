/**
 * The invoices screen (Facturas): its list query, its pages and the bodies
 * of its actions. Pure, tested in invoice-list.spec.ts.
 */

/** What the backend answers when it does not say: its default page size. */
export const INVOICE_PAGE_SIZE = 50;

/** The statuses an invoice really has. */
export const INVOICE_STATUS_FILTERS = ["all", "issued", "cancelled"] as const;
export type InvoiceStatusFilter = (typeof INVOICE_STATUS_FILTERS)[number];

export interface InvoiceListFilters {
  page: number;
  q?: string;
  /** YYYY-MM-DD, included. */
  dateFrom?: string;
  /** YYYY-MM-DD, included. */
  dateTo?: string;
  status?: InvoiceStatusFilter;
}

/**
 * GET /invoices query. `page`, `q`, `dateFrom`, `dateTo` and `status` are the
 * server's names; `fromDate` / `toDate` are the older ones, sent too so an
 * older server still filters by date (its toDate was "until that instant":
 * the end of the day is sent). `limit` is left at the server's default.
 */
export function invoiceListQuery(filters: InvoiceListFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.page > 1) out.page = String(Math.trunc(filters.page));
  const q = filters.q?.trim();
  if (q) out.q = q.slice(0, 100);
  if (filters.dateFrom) {
    out.dateFrom = filters.dateFrom;
    out.fromDate = filters.dateFrom;
  }
  if (filters.dateTo) {
    out.dateTo = filters.dateTo;
    out.toDate = `${filters.dateTo}T23:59:59.999Z`;
  }
  if (filters.status && filters.status !== "all") out.status = filters.status;
  return out;
}

export interface InvoicePage<T> {
  items: T[];
  /** Total matching invoices when the server says; null otherwise. */
  total: number | null;
  hasNext: boolean;
}

/**
 * The page the server answered: a plain array (a full page means there may
 * be more), or `{ items | data, total }`.
 */
export function invoicePage<T>(response: unknown, page: number, pageSize = INVOICE_PAGE_SIZE): InvoicePage<T> {
  if (Array.isArray(response)) {
    return { items: response as T[], total: null, hasNext: response.length >= pageSize };
  }
  const r = (response ?? {}) as { items?: unknown; data?: unknown; total?: unknown; limit?: unknown };
  const items = (Array.isArray(r.items) ? r.items : Array.isArray(r.data) ? r.data : []) as T[];
  const size = typeof r.limit === "number" && r.limit > 0 ? r.limit : pageSize;
  if (typeof r.total === "number") {
    return { items, total: r.total, hasNext: page * size < r.total };
  }
  return { items, total: null, hasNext: items.length >= size };
}

/** "YYYY-MM-DD" of `instant` on the calendar of `timeZone` (the salon's). */
export function dayInZone(instant: Date | number, timeZone: string): string {
  const format = (zone: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instant));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  try {
    return format(timeZone || "Europe/Madrid");
  } catch {
    return format("Europe/Madrid");
  }
}

// ---- Rectificativa (POST /invoices/:id/rectify) ----

export type RectifyMode = "full" | "lines" | "amount";

export interface RectifyLineChoice {
  /** The line of the original invoice. */
  originalLineId: string;
  /** Units to give back, positive (sent negative); at most the line's quantity. */
  quantity: number;
}

export interface RectifyBody {
  reason: string;
  lines?: Array<
    | { originalLineId: string; quantity: number }
    | { description: string; quantity: number; unitPriceCents: number; taxRate: number; taxIncluded: boolean }
  >;
}

/**
 * The body of a rectificativa, or the reason it cannot be sent yet.
 *  - full: no lines (the server credits what is left of every line);
 *  - lines: each chosen line with minus the units given back;
 *  - amount: one free line of minus that amount, tax included, at `taxRate`.
 */
export function rectifyBody(input: {
  mode: RectifyMode;
  reason: string;
  lines?: RectifyLineChoice[];
  amountCents?: number;
  taxRate?: number;
  description?: string;
}): { body: RectifyBody } | { error: string } {
  const reason = input.reason.trim();
  if (!reason) return { error: "Indica el motivo de la rectificativa." };
  if (reason.length > 500) return { error: "El motivo no puede tener más de 500 caracteres." };
  if (input.mode === "full") return { body: { reason } };
  if (input.mode === "lines") {
    const chosen = (input.lines ?? []).filter((l) => Number.isFinite(l.quantity) && l.quantity > 0);
    if (!chosen.length) return { error: "Elige al menos una línea y cuántas unidades se devuelven." };
    return {
      body: {
        reason,
        lines: chosen.map((l) => ({ originalLineId: l.originalLineId, quantity: -Math.round(l.quantity * 1000) / 1000 })),
      },
    };
  }
  const cents = Math.round(input.amountCents ?? 0);
  if (!Number.isFinite(cents) || cents <= 0) return { error: "Indica el importe a abonar, mayor que cero." };
  return {
    body: {
      reason,
      lines: [
        {
          description: input.description?.trim() || "Abono",
          quantity: -1,
          unitPriceCents: cents,
          taxRate: input.taxRate ?? 0,
          taxIncluded: true,
        },
      ],
    },
  };
}

/** "12,50" or "12.50" -> 1250; anything else -> NaN. */
export function parseEuros(text: string): number {
  const t = text.trim().replace(/\s|€/g, "");
  if (!/^\d+([.,]\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t.replace(",", ".")) * 100);
}
