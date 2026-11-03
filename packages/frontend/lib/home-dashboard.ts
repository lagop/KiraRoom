/**
 * Pure pieces of the panel's Inicio (app/dashboard/page.tsx) and of the
 * agenda filters its "Ver todas" links open. Tested in home-dashboard.spec.ts.
 */

/** A payment as GET /payments/today returns it (cents). */
export interface TodayPaymentRow {
  amount: number | string | null | undefined;
  status: string;
  /** What has been given back of it (partial refunds), in cents. */
  refundedAmount?: number | null;
}

/**
 * "Cobros de hoy": what was charged today and kept, like Pagos' summary.
 * Only paid payments count, less what was given back of them; failed,
 * pending and fully refunded ones are not money taken. The home used to
 * add every row: a card declined and then paid in cash counted twice.
 */
export function todayPaymentsFigures(payments: readonly TodayPaymentRow[]): { totalCents: number; count: number } {
  const paid = payments.filter((p) => p.status === "paid");
  const totalCents = paid.reduce(
    (sum, p) => sum + Math.max(0, Number(p.amount ?? 0) - Number(p.refundedAmount ?? 0)),
    0,
  );
  return { totalCents, count: paid.length };
}

function minutes(time: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Today's appointments still to come at the salon's `now` ("HH:mm"): those
 * not started yet, and those in progress.
 */
export function remainingToday<T extends { scheduledTime: string; status: string }>(rows: readonly T[], now: string): T[] {
  const nowMin = minutes(now);
  return rows.filter((r) => {
    if (r.status === "in_progress") return true;
    const at = minutes(r.scheduledTime);
    return nowMin === null || at === null || at >= nowMin;
  });
}

/** The hour of the salon's "HH:mm" clock, or null. */
export function hourOf(time: string | null | undefined): number | null {
  const m = minutes(time);
  return m === null ? null : Math.floor(m / 60);
}

/**
 * The translation key of a count: `<base>_one` for 1, `<base>_other`
 * otherwise ("1 cita", "3 citas").
 */
export function countKey(base: string, count: number): string {
  return `${base}_${count === 1 ? "one" : "other"}`;
}

/** An appointment's status label (singular): the agenda's own keys. */
export function statusLabelKey(status: string): string {
  return `appointments.status_${status}`;
}

/**
 * The status donut's colours, by status. The API's `color` is a Tailwind
 * class ("bg-green-500"): as an SVG stroke it drew nothing, a grey ring.
 */
export const DONUT_COLORS: Readonly<Record<string, string>> = {
  completed: "#10b981",
  confirmed: "#3b82f6",
  pending: "#eab308",
  in_progress: "#8b5cf6",
  cancelled: "#ef4444",
  no_show: "#6b7280",
};

export function donutColor(status: string | undefined): string {
  return (status && DONUT_COLORS[status]) || "#9ca3af";
}

/** The donut legend's label, Analítica's status names. */
const DONUT_LABEL_KEYS: Readonly<Record<string, string>> = {
  completed: "analytics.completed",
  confirmed: "analytics.status_confirmed",
  pending: "analytics.status_pending",
  in_progress: "analytics.status_in_progress",
  cancelled: "analytics.cancelled",
  no_show: "analytics.no_show",
};

export function donutLabelKey(status: string | undefined): string | null {
  return (status && DONUT_LABEL_KEYS[status]) || null;
}

// ----- The agenda's filters from Inicio ------------------------------------

/**
 * What a "Ver todas" link of Inicio asks the agenda's list for:
 * `?status=pending` the appointments to confirm (from today on),
 * `?paymentStatus=pending` the visits still to charge (up to today).
 */
export type AgendaFocus = "pending" | "unpaid";

export function agendaFocusFromQuery(params: { get(name: string): string | null } | null | undefined): AgendaFocus | null {
  if (!params) return null;
  if (params.get("paymentStatus") === "pending") return "unpaid";
  if (params.get("status") === "pending") return "pending";
  return null;
}

export const AGENDA_FOCUS_HREF: Readonly<Record<AgendaFocus, string>> = {
  pending: "/dashboard/appointments?status=pending",
  unpaid: "/dashboard/appointments?paymentStatus=pending",
};

interface FocusAppointment {
  scheduledDate: string;
  status: string;
  paymentStatus?: string | null;
  amountDue?: number | null;
}

/**
 * Whether an appointment belongs in the focused list, with Inicio's rules
 * (GET /appointments/home): to confirm = pending, today or later; to charge
 * = payment pending or failed, not cancelled nor a no-show, up to today,
 * something still owed.
 */
export function matchesAgendaFocus(apt: FocusAppointment, focus: AgendaFocus, today: string): boolean {
  const day = String(apt.scheduledDate ?? "").slice(0, 10);
  if (focus === "pending") return apt.status === "pending" && day >= today;
  return (
    (apt.paymentStatus === "pending" || apt.paymentStatus === "failed") &&
    apt.status !== "cancelled" &&
    apt.status !== "no_show" &&
    day <= today &&
    (apt.amountDue === undefined || apt.amountDue === null || apt.amountDue > 0)
  );
}

/** "Ana López", or "" when there is no one (the caller says "sin nombre"). */
export function personName(p: { firstName?: string | null; lastName?: string | null } | null | undefined): string {
  if (!p) return "";
  return `${p.firstName ?? ""} ${p.lastName ?? ""}`.replace(/\s+/g, " ").trim();
}

// ----- Agenda de hoy por profesional (D30) ---------------------------------

interface AgendaPerson {
  id: string;
  firstName: string;
  lastName: string;
}

export interface ProfessionalAgenda<T> {
  /** null: appointments with no professional. */
  professional: AgendaPerson | null;
  appointments: T[];
}

/**
 * Today's appointments under each professional: every one of the team, in
 * its order, those with nothing booked too (who is free shows at a glance),
 * then anyone booked who is not in it (e.g. made inactive since), then
 * appointments with no professional. Each list keeps the order it came in.
 */
export function agendaByProfessional<T extends { professional?: AgendaPerson | null }>(
  team: readonly AgendaPerson[],
  appointments: readonly T[],
): ProfessionalAgenda<T>[] {
  const groups = new Map<string, ProfessionalAgenda<T>>();
  for (const p of team) groups.set(p.id, { professional: p, appointments: [] });
  const unassigned: T[] = [];
  for (const a of appointments) {
    const p = a.professional;
    if (!p) {
      unassigned.push(a);
      continue;
    }
    if (!groups.has(p.id)) groups.set(p.id, { professional: p, appointments: [] });
    groups.get(p.id)!.appointments.push(a);
  }
  const out = [...groups.values()];
  if (unassigned.length) out.push({ professional: null, appointments: unassigned });
  return out;
}

/** Whether a today's appointment is already behind the salon's clock (not started, its time gone). */
export function isPast(row: { scheduledTime: string; status: string }, now: string): boolean {
  return remainingToday([row], now).length === 0;
}
