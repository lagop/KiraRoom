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
 * ISO yyyy-mm-dd → "Monday, March 17, 2026".
 */
export function formatDateString(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * ISO yyyy-mm-dd → "Mar 17, 2026, 02:30 PM".
 */
export function formatDateTimeString(dateString: string): string {
  return new Date(dateString).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Date → "yyyy-mm-dd" (UTC ISO date part). Used by the suggestion
 * generator to stamp each suggestion with its date label.
 */
export function formatIsoDate(date: Date): string {
  return date.toISOString().split("T")[0];
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
      label: "Confirmed",
    },
    pending: {
      bg: "bg-yellow-50",
      text: "text-yellow-700",
      border: "border-yellow-200",
      label: "Pending",
    },
    in_progress: {
      bg: "bg-blue-50",
      text: "text-blue-700",
      border: "border-blue-200",
      label: "In Progress",
    },
    completed: {
      bg: "bg-blue-50",
      text: "text-blue-700",
      border: "border-blue-200",
      label: "Completed",
    },
    cancelled: {
      bg: "bg-red-50",
      text: "text-red-700",
      border: "border-red-200",
      label: "Cancelled",
    },
    no_show: {
      bg: "bg-gray-50",
      text: "text-gray-700",
      border: "border-gray-300",
      label: "No-show",
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
 * Resolve a professional name for display. Returns "Staff" for
 * undefined / unknown ids so the UI never has to deal with `null`.
 */
export function getProfessionalName(
  profId: string | undefined,
  professionals: ReadonlyArray<{
    id: string;
    firstName: string;
    lastName: string;
  }>,
): string {
  if (!profId) return "Staff";
  const prof = professionals.find((p) => p.id === profId);
  return prof ? `${prof.firstName} ${prof.lastName}` : "Staff";
}

/**
 * Sum of `selectedServices` durations, ignoring parallel/serial
 * semantics. Used by the suggestion generator when it wants the
 * total time on the day, not the schedule-aware duration.
 */
export function sumServiceDurations(
  selectedServices: ReadonlyArray<{ serviceId: string }>,
  services: ReadonlyArray<{ id: string; duration?: number | null }>,
  defaultDuration: number = 60,
): number {
  return selectedServices.reduce((sum, sel) => {
    const service = services.find((s) => s.id === sel.serviceId);
    return sum + (Number(service?.duration) || defaultDuration);
  }, 0);
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
      ? { depositRequired: true, depositAmount: Math.round((input.depositAmount || 0) * 100) }
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
