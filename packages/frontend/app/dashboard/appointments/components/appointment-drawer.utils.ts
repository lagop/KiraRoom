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