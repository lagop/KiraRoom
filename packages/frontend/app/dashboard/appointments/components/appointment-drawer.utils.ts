/**
 * Pure helpers extracted from `appointment-drawer.tsx`.
 *
 * Keeping these free of React state, API calls, and DOM access makes
 * them trivially unit-testable from Node (`ts-node`). The
 * `appointment-drawer.tsx` file is now the only place that bridges
 * these helpers to React state.
 *
 * No imports from `@/lib/api`, no React hooks, no `useState`/
 * `useEffect` — just data in, data out. The component file imports
 * these and threads its own state into them.
 */

import { dateOfDay } from "../../../../components/Calendar/day-grid";
import { formatPrice } from "../../../../lib/salon-seo";
import type { Appointment } from "./appointment-drawer/types";

/**
 * "HH:MM" string + minutes → "HH:MM" string. Wraps at midnight (so
 * 23:30 + 60 → "00:30").
 */
export function addMinutesToTime(timeStr: string, minutes: number): string {
  const [hours, mins] = timeStr.split(":").map(Number);
  const totalMinutes = (hours * 60 + mins + minutes) % (24 * 60);
  const safeTotal = totalMinutes < 0 ? totalMinutes + 24 * 60 : totalMinutes;
  const newHours = Math.floor(safeTotal / 60);
  const newMins = safeTotal % 60;
  return `${String(newHours).padStart(2, "0")}:${String(newMins).padStart(2, "0")}`;
}

/**
 * "yyyy-mm-dd" → "martes, 17 de marzo de 2026". Read as the local calendar
 * day: `new Date("2026-03-17")` is UTC midnight, the 16th west of UTC.
 */
export function formatDateString(day: string): string {
  if (!day) return "";
  return dateOfDay(day).toLocaleDateString("es-ES", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** "yyyy-mm-dd" (or an ISO date-time) → "17/03/2026", the local calendar day. */
export function formatShortDay(day: string): string {
  if (!day) return "";
  return dateOfDay(day).toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** An instant (createdAt, an activity entry) → "17 mar 2026, 15:30". */
export function formatDateTimeString(dateString: string): string {
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleString("es-ES", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ----- Money -----------------------------------------------------------------
//
// The API mixes units: a service's and an appointment's `price` are euros;
// `totalAmount`, `amountPaid`, `amountDue` and `depositAmount` are cents.

/** Euros → "35,00 €". */
export function formatEuros(euros: number | string | null | undefined): string {
  return formatPrice(Number(euros) || 0);
}

/** Cents (`totalAmount`, `amountPaid`, `depositAmount`) → "35,00 €". */
export function formatCents(cents: number | string | null | undefined): string {
  return formatPrice(centsToEuros(cents));
}

/** Euros as typed in a form → whole cents, as the API stores a deposit. */
export function eurosToCents(euros: number | string | null | undefined): number {
  const n = typeof euros === "string" ? Number(euros.replace(",", ".")) : Number(euros);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Cents from the API → euros, for a form field or a sum. */
export function centsToEuros(cents: number | string | null | undefined): number {
  const n = Number(cents);
  return Number.isFinite(n) ? Math.round(n) / 100 : 0;
}

/**
 * What the visit costs, in cents: the server's `totalAmount` (it adds up
 * every service and add-on), else the services' prices, else `price`.
 */
export function appointmentTotalCents(appointment: {
  totalAmount?: number | string | null;
  price?: number | string | null;
  services?: ReadonlyArray<{ service?: { price?: number | string | null } | null }> | null;
}): number {
  const total = Number(appointment.totalAmount);
  if (Number.isFinite(total) && total > 0) return Math.round(total);
  const rows = appointment.services ?? [];
  const fromRows = rows.reduce((sum, r) => sum + (Number(r.service?.price) || 0), 0);
  if (fromRows > 0) return eurosToCents(fromRows);
  return eurosToCents(appointment.price);
}

// ----- Commission and deposit (the salon's terms) ---------------------------

/**
 * The rate the server applies when neither the appointment nor the
 * professional sets one (commissions.service.ts).
 */
export const DEFAULT_COMMISSION_RATE = 10;

export type CommissionSource = "appointment" | "professional" | "default";

/**
 * A rate from the API (a Decimal string), a form, or nothing. 0 is a rate;
 * null, undefined and "" are "not set".
 */
export function parseRate(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * The commission that applies to an appointment, and where it comes from:
 * its own override (0 included), else the professional's, else the default.
 * The same order the server's commission calculation uses.
 */
export function effectiveCommission(
  appointmentRate: unknown,
  professionalRate: unknown,
): { rate: number; source: CommissionSource } {
  const own = parseRate(appointmentRate);
  if (own !== null) return { rate: own, source: "appointment" };
  const professional = parseRate(professionalRate);
  if (professional !== null) return { rate: professional, source: "professional" };
  return { rate: DEFAULT_COMMISSION_RATE, source: "default" };
}

/** 12.5 → "12,5 %". */
export function formatRate(rate: number): string {
  return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(rate)} %`;
}

/** The salon's terms on an appointment, as the edit form holds them. */
export interface SalonTermsForm {
  /** "" = no override (the professional's or the default rate); "0" is 0 %. */
  commission: string;
  depositRequired: boolean;
  /** Euros, as typed. */
  deposit: string;
}

export function salonTermsForm(appointment: {
  commissionRate?: unknown;
  depositRequired?: boolean | null;
  depositAmount?: number | string | null;
}): SalonTermsForm {
  const rate = parseRate(appointment.commissionRate);
  const cents = Number(appointment.depositAmount);
  return {
    commission: rate === null ? "" : String(rate),
    depositRequired: !!appointment.depositRequired,
    deposit: Number.isFinite(cents) && cents > 0 ? String(centsToEuros(cents)) : "",
  };
}

/** Whether the form holds something the server would refuse (a rate outside 0-100, a negative deposit). */
export function salonTermsInvalid(form: SalonTermsForm): boolean {
  if (form.commission.trim() !== "" && parseRate(form.commission) === null) return true;
  if (form.depositRequired && form.deposit.trim() !== "") {
    const n = Number(form.deposit.replace(",", "."));
    if (!Number.isFinite(n) || n < 0) return true;
  }
  return false;
}

/**
 * The part of PATCH /appointments/:id that changes the salon's terms: only
 * what changed, and only for an owner or manager (the server ignores them
 * from a professional). The deposit goes in cents, as it is stored; a
 * cleared commission goes as null, so the professional's rate applies
 * again, and 0 stays 0.
 */
export function salonTermsUpdate(input: {
  role?: string;
  before: {
    commissionRate?: unknown;
    depositRequired?: boolean | null;
    depositAmount?: number | string | null;
  };
  form: SalonTermsForm;
}): { commissionRate?: number | null; depositRequired?: boolean; depositAmount?: number } {
  if (input.role !== "owner" && input.role !== "admin") return {};
  const out: { commissionRate?: number | null; depositRequired?: boolean; depositAmount?: number } = {};
  const rateBefore = parseRate(input.before.commissionRate);
  const rateAfter = parseRate(input.form.commission);
  if (rateAfter !== rateBefore) out.commissionRate = rateAfter;
  if (input.form.depositRequired !== !!input.before.depositRequired) {
    out.depositRequired = input.form.depositRequired;
  }
  if (input.form.depositRequired) {
    const cents = Math.max(0, eurosToCents(input.form.deposit));
    const centsBefore = Math.round(Number(input.before.depositAmount) || 0);
    if (cents !== centsBefore) out.depositAmount = cents;
  }
  return out;
}

/**
 * Total price across the selectedServices (preferred) or the
 * single fallbackServiceId. Returns 0 when no selection resolves.
 */
export function getTotalPrice(
  selectedServices: ReadonlyArray<{ serviceId: string }>,
  services: ReadonlyArray<{ id: string; price?: number | null }>,
  fallbackServiceId?: string,
): number {
  if (selectedServices.length === 0 && fallbackServiceId) {
    const service = services.find((s) => s.id === fallbackServiceId);
    return Number(service?.price) || 0;
  }
  return selectedServices.reduce((total, sel) => {
    const service = services.find((s) => s.id === sel.serviceId);
    return total + (Number(service?.price) || 0);
  }, 0);
}

/**
 * Total duration across selectedServices. Serial services sum
 * their durations; parallel services take the longest one. Without
 * multi-service support, falls back to the single fallback service.
 */
export function getTotalDuration(
  selectedServices: ReadonlyArray<{
    serviceId: string;
    isParallel?: boolean;
  }>,
  services: ReadonlyArray<{ id: string; duration?: number | null }>,
  fallbackServiceId?: string,
): number {
  if (selectedServices.length === 0) {
    if (!fallbackServiceId) return 0;
    const service = services.find((s) => s.id === fallbackServiceId);
    return Number(service?.duration) || 0;
  }
  const parallel = selectedServices.filter((s) => s.isParallel);
  const sequential = selectedServices.filter((s) => !s.isParallel);

  const sequentialDuration = sequential.reduce((total, sel) => {
    const service = services.find((s) => s.id === sel.serviceId);
    return total + (Number(service?.duration) || 0);
  }, 0);

  const parallelDuration =
    parallel.length > 0
      ? Math.max(
          ...parallel.map((sel) => {
            const service = services.find((s) => s.id === sel.serviceId);
            return Number(service?.duration) || 0;
          }),
        )
      : 0;

  return sequentialDuration + parallelDuration;
}

/**
 * Total duration for an existing appointment (view-mode shape).
 * Same serial/parallel rule as `getTotalDuration`, plus addons.
 */
export function calculateTotalDuration(appointment: {
  service?: { duration?: number | null } | null;
  services?: Array<{
    service?: { duration?: number | null } | null;
    isParallel?: boolean;
  }>;
  addons?: Array<{ duration?: number | null }>;
}): number {
  const addonsDuration =
    appointment.addons?.reduce(
      (sum, addon) => sum + (Number(addon.duration) || 0),
      0,
    ) || 0;

  if (!appointment.services || appointment.services.length === 0) {
    return (Number(appointment.service?.duration) || 0) + addonsDuration;
  }

  const parallel = appointment.services.filter((s) => s.isParallel);
  const serial = appointment.services.filter((s) => !s.isParallel);

  const serialDuration = serial.reduce(
    (sum, s) => sum + (Number(s.service?.duration) || 0),
    0,
  );
  const parallelDuration =
    parallel.length > 0
      ? Math.max(...parallel.map((s) => Number(s.service?.duration) || 0))
      : 0;

  return serialDuration + parallelDuration + addonsDuration;
}

/**
 * Normalise the raw addons payload from the backend into the
 * shape the drawer renders. Accepts:
 *   - `null`/`undefined` → []
 *   - Array of { addonId|serviceId, quantity }
 *   - Object with `set: [...]`
 *   - Object with arbitrary id → quantity entries
 *
 * Each entry is then resolved against the services catalog to
 * pull in name, price, and duration. Unresolvable entries are
 * dropped silently.
 */
export function transformAddons(
  rawAddons: any,
  services: ReadonlyArray<{
    id: string;
    name: string;
    price?: number | null;
    duration?: number | null;
  }>,
): Array<{
  id: string;
  name: string;
  quantity: number;
  price: number;
  duration: number;
}> {
  if (!rawAddons) return [];

  let addonArray: any[] = [];

  if (Array.isArray(rawAddons)) {
    addonArray = rawAddons;
  } else if (
    typeof rawAddons === "object" &&
    rawAddons.set &&
    Array.isArray(rawAddons.set)
  ) {
    addonArray = rawAddons.set;
  } else if (typeof rawAddons === "object") {
    addonArray = Object.entries(rawAddons).map(([addonId, quantity]) => ({
      addonId,
      quantity,
    }));
  }

  return addonArray
    .flat()
    .filter((item) => item && (item.addonId || item.serviceId))
    .map((addonData) => {
      const addonId = addonData.addonId || addonData.serviceId;
      const service = services.find(
        (s) => String(s.id) === String(addonId),
      );
      if (!service) return null;
      return {
        id: String(addonId),
        name: service.name,
        quantity: addonData.quantity,
        price: Number(service.price) || 0,
        duration: Number(service.duration) || 0,
      };
    })
    .filter(
      (item): item is {
        id: string;
        name: string;
        quantity: number;
        price: number;
        duration: number;
      } => item !== null,
    );
}

/**
 * Status badge styling for the appointment status pill. Returns
 * the Tailwind classes only — no JSX so this stays pure.
 */
export function getStatusBadgeStyle(status: string): {
  bg: string;
  text: string;
  border: string;
  label: string;
} {
  const styles: Record<
    string,
    { bg: string; text: string; border: string; label: string }
  > = {
    confirmed: {
      bg: "bg-green-50",
      text: "text-green-700",
      border: "border-green-200",
      label: "Confirmada",
    },
    pending: {
      bg: "bg-yellow-50",
      text: "text-yellow-700",
      border: "border-yellow-200",
      label: "Pendiente",
    },
    in_progress: {
      bg: "bg-blue-50",
      text: "text-blue-700",
      border: "border-blue-200",
      label: "En curso",
    },
    completed: {
      bg: "bg-blue-50",
      text: "text-blue-700",
      border: "border-blue-200",
      label: "Completada",
    },
    cancelled: {
      bg: "bg-red-50",
      text: "text-red-700",
      border: "border-red-200",
      label: "Cancelada",
    },
    no_show: {
      bg: "bg-gray-50",
      text: "text-gray-700",
      border: "border-gray-300",
      label: "No se presentó",
    },
  };
  return (
    styles[status] ?? {
      bg: "bg-gray-50",
      text: "text-gray-700",
      border: "border-gray-200",
      label: status,
    }
  );
}

/**
 * Where "Editar" on the appointment detail page goes. It used to push
 * `/dashboard/appointments/:id/edit`, a page that does not exist (404):
 * appointments are edited in the agenda's drawer, which the agenda opens
 * from these query params.
 */
export function appointmentEditHref(appointmentId: string): string {
  return `/dashboard/appointments?appointment=${encodeURIComponent(appointmentId)}&edit=1`;
}

export type DrawerTarget =
  | { mode: "new" }
  | { mode: "existing"; appointmentId: string; edit: boolean };

/** What the agenda's drawer should open from its URL, or null for nothing. */
export function drawerTargetFromQuery(
  params: { get(name: string): string | null } | null | undefined,
): DrawerTarget | null {
  if (!params) return null;
  const id = params.get("appointment");
  if (id) return { mode: "existing", appointmentId: id, edit: params.get("edit") === "1" };
  if (params.get("new") === "true") return { mode: "new" };
  return null;
}
// ----- Status changes -----------------------------------------------------

export type AppointmentStatusValue =
  | "pending"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

/**
 * What may follow each status: a copy of the server's table
 * (packages/backend/src/appointments/appointment-status.ts). The server
 * decides, and answers 409 with the reason otherwise; this only keeps the
 * panel from offering a button that would be refused. Completed and
 * cancelled are final; a no-show can go back to confirmed (a client who
 * turns up late).
 */
export const NEXT_STATUSES: Readonly<
  Record<AppointmentStatusValue, readonly AppointmentStatusValue[]>
> = {
  pending: ["confirmed", "in_progress", "completed", "cancelled", "no_show"],
  confirmed: ["in_progress", "completed", "cancelled", "no_show"],
  in_progress: ["confirmed", "completed", "cancelled"],
  completed: [],
  cancelled: [],
  no_show: ["confirmed"],
};

export function canChangeStatus(from: string, to: AppointmentStatusValue): boolean {
  return (NEXT_STATUSES[from as AppointmentStatusValue] ?? []).includes(to);
}

/**
 * The status buttons the list and the drawer show, in order: the next step
 * of the visit, then "No se presentó", then "Cancelar". A no-show offers
 * "Confirmar" again for a client who arrived late.
 */
export function statusActions(from: string): AppointmentStatusValue[] {
  const byStatus: Record<string, AppointmentStatusValue[]> = {
    pending: ["confirmed", "no_show", "cancelled"],
    confirmed: ["in_progress", "no_show", "cancelled"],
    in_progress: ["completed", "cancelled"],
    no_show: ["confirmed"],
  };
  return (byStatus[from] ?? []).filter((to) => canChangeStatus(from, to));
}

/**
 * The changes the panel asks about before sending: cancelling and a no-show
 * tell the client, and completing is final and may issue an invoice.
 */
export type AskedStatus = "cancelled" | "no_show" | "completed";

export function asksFirst(to: string): to is AskedStatus {
  return to === "cancelled" || to === "no_show" || to === "completed";
}

/** The i18n key of a status's badge label ("appointments.status_no_show"). */
export function statusLabelKey(status: string): string | null {
  return status in NEXT_STATUSES ? `appointments.status_${status}` : null;
}

/** The API calls a status change may use (a subset of the panel's client). */
export interface StatusChangeApi {
  cancelAppointment(id: string, reason?: string): Promise<unknown>;
  completeAppointment(id: string): Promise<unknown>;
  markAppointmentNoShow(id: string): Promise<unknown>;
  // The panel client types its edit body without `status`; any body will do here.
  updateAppointment(id: string, data: object): Promise<unknown>;
}

/**
 * Sends a status change to the route that owns it. Cancelling, completing
 * and a no-show have their own endpoints, which send the notices, offer the
 * slot to the wait-list, issue the invoice and so on; the rest is an edit.
 */
export function sendStatusChange(
  api: StatusChangeApi,
  id: string,
  to: AppointmentStatusValue,
  reason?: string,
): Promise<unknown> {
  switch (to) {
    case "cancelled":
      return api.cancelAppointment(id, reason?.trim() || undefined);
    case "completed":
      return api.completeAppointment(id);
    case "no_show":
      return api.markAppointmentNoShow(id);
    default:
      return api.updateAppointment(id, { status: to });
  }
}

/** The server's reason for a refusal (a 409 on a transition), if it gave one. */
export function serverMessage(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message.trim() : "";
  return message || undefined;
}

// ----- The appointment as the drawer and the detail page show it ------------

/** The activity entry the panel adds for the appointment's creation. */
export const CREATED_ACTIVITY = "appointment_created";

const ACTIVITY_KEYS: Record<string, string> = {
  [CREATED_ACTIVITY]: "created",
  appointment_updated: "updated",
  appointment_cancelled: "cancelled",
  appointment_completed: "completed",
  appointment_no_show: "no_show",
  appointment_status_changed: "status_changed",
};

/** The i18n key of an activity entry ("appointments.activityActions.cancelled"), or null for one the panel does not know. */
export function activityLabelKey(action: string): string | null {
  const key = ACTIVITY_KEYS[action];
  return key ? `appointments.activityActions.${key}` : null;
}

/**
 * The activity list: the panel's "created" entry and the server's entries
 * (GET /appointments/:id/activity), newest first, without duplicates.
 */
export function mergeActivity(
  createdAt: string,
  entries: ReadonlyArray<{ createdAt: string; action: string; details?: unknown }> | null | undefined,
): Array<{ timestamp: string; action: string; details?: string }> {
  const byKey = new Map<string, { timestamp: string; action: string; details?: string }>();
  byKey.set(`${createdAt}-${CREATED_ACTIVITY}`, { timestamp: createdAt, action: CREATED_ACTIVITY });
  for (const entry of entries ?? []) {
    const key = `${entry.createdAt}-${entry.action}`;
    if (byKey.has(key)) continue;
    byKey.set(key, {
      timestamp: entry.createdAt,
      action: entry.action,
      details: entry.details ? JSON.stringify(entry.details) : undefined,
    });
  }
  return Array.from(byKey.values()).sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * GET /appointments/:id → the drawer's shape. Carries the salon's terms
 * (commission, deposit) and the server's totals, which it used to drop: the
 * drawer showed no commission, and an edit could not keep the deposit.
 */
export function toDrawerAppointment(
  data: any,
  services: ReadonlyArray<{ id: string; name: string; price?: number | null; duration?: number | null }> = [],
): Appointment {
  const fullName = (p: { firstName?: string; lastName?: string } | null | undefined) =>
    `${p?.firstName ?? ""} ${p?.lastName ?? ""}`.trim();
  const toService = (s: any) => ({
    id: s?.id ?? "",
    name: s?.name ?? "",
    description: s?.description || "",
    duration: Number(s?.duration) || 0,
    price: Number(s?.price) || 0,
  });
  return {
    id: data.id,
    client: {
      id: data.client?.id ?? "",
      name: fullName(data.client),
      email: data.client?.email || "",
      phone: data.client?.phone || "",
    },
    professional: {
      id: data.professional?.id ?? "",
      name: fullName(data.professional),
      email: data.professional?.email || "",
      phone: data.professional?.phone || "",
      specialty: data.professional?.specialties?.[0] || "",
    },
    service: toService(data.service),
    services: (data.services ?? []).map((s: any) => ({
      id: s.id,
      service: toService(s.service),
      professional: s.professional
        ? {
            id: s.professional.id,
            firstName: s.professional.firstName,
            lastName: s.professional.lastName,
            email: s.professional.email,
            phone: s.professional.phone || "",
            specialties: s.professional.specialties || [],
          }
        : undefined,
      isParallel: !!s.isParallel,
      scheduledStart: s.scheduledStart,
      scheduledEnd: s.scheduledEnd,
    })),
    rawAddons: data.addons,
    addons: services.length > 0 ? transformAddons(data.addons, services) : [],
    date: String(data.scheduledDate ?? "").split("T")[0],
    time: data.scheduledTime,
    status: data.status,
    price: Number(data.price) || 0,
    notes: data.notes || "",
    locationId: data.locationId ?? null,
    commissionRate: numberOrNull(data.commissionRate),
    professionalCommissionRate: numberOrNull(data.professional?.commissionRate),
    depositRequired: !!data.depositRequired,
    depositAmount: numberOrNull(data.depositAmount),
    depositPaid: !!data.depositPaid,
    totalAmount: numberOrNull(data.totalAmount) ?? undefined,
    amountPaid: numberOrNull(data.amountPaid) ?? undefined,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    activity: [{ timestamp: data.createdAt, action: CREATED_ACTIVITY, details: undefined }],
  };
}

/**
 * What a professional (role `staff`) sees in the new-appointment form:
 * their own professional record and the services they perform.
 *
 * The token carries no professional id, and the drawer used to look the
 * professional up on /admin/professionals, which answers 403 to staff: the
 * service list came out empty and the form said "Asignado a: undefined
 * undefined". The salon's professionals list (/professionals, full rows for
 * the salon's own team) carries each professional's `userId`, which is how
 * the server also finds the caller's professional.
 *
 * A professional with no services linked sees every service, as the
 * booking engine treats them as able to do any (findFreeProfessional).
 * Null when the account is not linked to a professional of the salon.
 */
export function staffOwnCatalog<
  P extends { id: string; userId?: string | null; services?: ReadonlyArray<{ serviceId: string }> },
  S extends { id: string },
>(
  userId: string | undefined,
  professionals: ReadonlyArray<P>,
  services: ReadonlyArray<S>,
): { me: P; professionals: P[]; services: S[] } | null {
  if (!userId) return null;
  const me = professionals.find((p) => p.userId === userId);
  if (!me) return null;
  const mine = new Set((me.services ?? []).map((s) => s.serviceId));
  return {
    me,
    professionals: [me],
    services: mine.size > 0 ? services.filter((s) => mine.has(s.id)) : [...services],
  };
}

/** The body of POST /appointments/staff, built from the drawer's form. */
export interface StaffBookingPayload {
  clientId: string;
  serviceId: string;
  professionalId?: string;
  scheduledDate: string;
  scheduledTime: string;
  notes?: string;
  depositRequired?: boolean;
  depositAmount?: number;
  commissionRate?: number;
  services?: Array<{ serviceId: string; professionalId?: string; isParallel: boolean }>;
  allowOutsideHours?: true;
  /** Multi-local: the location picked in the drawer (lib/panel-booking-locations.ts). */
  locationId?: string;
}

/**
 * One request for the whole appointment. Multi-service bookings used to be
 * two calls (the appointment, then its services): when the second failed
 * the appointment stayed half-made, and retrying booked it twice. The
 * server now creates the appointment and its service rows together and
 * times the rows itself, from the start and each service's duration.
 *
 * - The commission goes only when an owner or manager typed one: sending
 *   the form's 0 stored "no commission" instead of the default.
 * - A professional's own bookings carry their professional id; the server
 *   forces it anyway.
 * - Null when the form lacks a client, a service, a day and time, or (for
 *   an owner or manager) a professional.
 */
export function buildStaffBookingPayload(input: {
  role?: string;
  /** The caller's own professional, for staff. */
  ownProfessionalId?: string;
  clientId: string;
  serviceId: string;
  professionalId: string;
  date: string;
  time: string;
  notes?: string;
  selectedServices: ReadonlyArray<{ serviceId: string; professionalId?: string; isParallel?: boolean }>;
  /** The professional the suggestion engine picked for each "auto-assign" service. */
  autoAssign?: Record<string, string>;
  depositRequired?: boolean;
  /** In euros, as typed. */
  depositAmount?: number;
  commissionRate?: number | null;
  allowOutsideHours?: boolean;
}): StaffBookingPayload | null {
  const staff = input.role === "staff";
  const own = staff ? input.ownProfessionalId || undefined : undefined;
  const rows = input.selectedServices.map((s) => ({
    serviceId: s.serviceId,
    professionalId: own ?? (s.professionalId || input.autoAssign?.[s.serviceId] || undefined),
    isParallel: !!s.isParallel,
  }));
  const serviceId = rows[0]?.serviceId || input.serviceId;
  const professionalId =
    own ?? (rows.find((r) => r.professionalId)?.professionalId || input.professionalId || undefined);
  if (!input.clientId || !serviceId || !input.date || !input.time) return null;
  if (!staff && !professionalId) return null;

  const manager = input.role === "owner" || input.role === "admin";
  const commission = input.commissionRate;
  return {
    clientId: input.clientId,
    serviceId,
    ...(professionalId ? { professionalId } : {}),
    scheduledDate: input.date,
    scheduledTime: input.time,
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.depositRequired
      ? { depositRequired: true, depositAmount: Math.max(0, eurosToCents(input.depositAmount)) }
      : {}),
    ...(manager && typeof commission === "number" && Number.isFinite(commission)
      ? { commissionRate: commission }
      : {}),
    // One service is the appointment itself; rows only for a visit of several.
    ...(rows.length > 1
      ? { services: rows.map((r) => ({ ...r, professionalId: r.professionalId || professionalId })) }
      : {}),
    ...(input.allowOutsideHours ? { allowOutsideHours: true as const } : {}),
  };
}
