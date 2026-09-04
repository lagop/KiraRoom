/**
 * APPOINTMENT SCHEDULER UTILITIES
 * Helper functions for data transformation and time handling
 */

import { format } from "date-fns";

type ProfessionalAvailability = Record<string, any[]>;

/**
 * Prepare service objects for the scheduler algorithm
 */
export function prepareServiceObjects(
  selectedServices: any[],
  allServices: any[],
  allProfessionals: any[],
) {
  return selectedServices
    .map((sel) => {
      const service = allServices.find((s) => s.id === sel.serviceId);
      const professional = allProfessionals.find(
        (p) => p.id === sel.professionalId,
      );

      if (!service) {
        console.warn(`Service ${sel.serviceId} not found in services list`);
        return null;
      }

      return {
        id: service.id,
        name: service.name,
        duration: service.duration || 60, // Default 60 minutes if not specified
        professionalId: sel.professionalId || "",
        professionalName: professional
          ? `${professional.firstName} ${professional.lastName}`
          : "Auto-assign",
        isParallel: sel.isParallel || false,
      };
    })
    .filter(Boolean); // Remove null entries
}

/**
 * Conflict checker – pure function so it can be reused for API slots and fallback slots.
 */
function doesSlotConflict(
  slotStartMin: number,
  slotEndMin: number,
  profId: string,
  existingAppointments: any[],
): boolean {
  const parseTime = (t?: string) => {
    if (!t || typeof t !== "string") return null;
    const m = t.match(/(\d{2}):(\d{2})/);
    return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
  };

  const overlaps = (busyStart: number, busyEnd: number) =>
    slotStartMin < busyEnd && slotEndMin > busyStart;

  return existingAppointments.some((appointment) => {
    const isForThisProfessional =
      appointment.professionalId === profId ||
      appointment.services?.some(
        (svc: any) =>
          svc.professional?.id === profId || svc.professionalId === profId,
      );

    if (!isForThisProfessional) return false;

    if (
      appointment.services &&
      Array.isArray(appointment.services) &&
      appointment.services.length > 0
    ) {
      return appointment.services.some((service: any) => {
        if (!service) return false;
        const svcProfId = service.professional?.id || service.professionalId;
        if (svcProfId !== profId) return false;

        let busyStart: number;
        let busyEnd: number;

        if (service.scheduledStart && service.scheduledEnd) {
          const s = parseTime(service.scheduledStart);
          const e = parseTime(service.scheduledEnd);
          if (s == null || e == null) return false;
          busyStart = s;
          busyEnd = e;
        } else {
          const t = parseTime(appointment.time || appointment.scheduledTime);
          if (t == null) return false;
          busyStart = t;
          busyEnd =
            t +
            (appointment.duration ||
              service.service?.duration ||
              service.duration ||
              60);
        }
        return overlaps(busyStart, busyEnd);
      });
    } else {
      const t = parseTime(appointment.time || appointment.scheduledTime);
      if (t == null) return false;
      const busyStart = t;
      const busyEnd = t + (appointment.duration || 60);
      return overlaps(busyStart, busyEnd);
    }
  });
}

/**
 * Fetch professional availability for multiple professionals
 * @param {string} date - Date string in YYYY-MM-DD format
 * @param {Array<string>} professionalIds - Array of professional IDs
 * @param {Object} apiClient - API client instance
 * @returns {Promise<Object>} Availability data grouped by professional
 */
export async function fetchProfessionalAvailability(
  date: string,
  professionalIds: string[],
  apiClient: any,
  serviceIds: string[] = [],
  tenantSettings?: any,
  serviceDuration?: number,
) {
  if (!professionalIds || professionalIds.length === 0) {
    return {};
  }

  const availability: ProfessionalAvailability = {};
  const warnings: string[] = [];

  // Get tenant ID from localStorage
  let tenantId = "default-tenant";
  const token =
    typeof window !== "undefined"
      ? localStorage.getItem("kira_auth_token")
      : null;

  if (token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      tenantId = payload.tenantId || "default-tenant";
    } catch (e) {
      console.error("Error parsing token:", e);
    }
  }


  const firstServiceId = serviceIds.length > 0 ? serviceIds[0] : "";

  // Fetch availability per-professional so each gets accurate individual slots.
  // The backend multi-professional endpoint returns slots where ALL professionals
  // are free (intersection), which is wrong for auto-assign where we need
  // per-professional availability to pick the best one.
  // Use first serviceId to check availability for the specific service.
  const perProfAvailability: { profId: string; slots: any[] }[] = [];
  for (const profId of professionalIds) {
    try {
      const slots = await apiClient.getAvailableSlots(
        tenantId,
        profId,
        firstServiceId,  // use first serviceId to check specific availability
        date,
      );
      perProfAvailability.push({ profId, slots });
    } catch (error) {
      console.error(`Error fetching availability for professional ${profId}:`, error);
      perProfAvailability.push({ profId, slots: [] });
    }
  }

  // Fetch existing confirmed appointments for this date to exclude conflicts
  let existingAppointments: any[] = [];
  try {
    const startDateStr = `${date}T00:00:00.000Z`;
    const endDateStr = `${date}T23:59:59.999Z`;

    try {
      existingAppointments = await apiClient.getAppointments({
        tenantId,
        startDate: startDateStr,
        endDate: endDateStr,
        status: "confirmed",
      });
    } catch (e) {
      console.warn("Failed with status filter, trying without:", e);
      existingAppointments = await apiClient.getAppointments({
        tenantId,
        startDate: startDateStr,
        endDate: endDateStr,
      });
    }
  } catch (error) {
    console.error(
      "CRITICAL: Could not fetch existing appointments, proceeding without conflict checking:",
      error,
    );
  }

  // Transform per-professional API responses.
  // The backend getAlready does full conflict checking (including pending appointments),
  // so we trust its isAvailable flag and only filter out past slots here.
  perProfAvailability.forEach(({ profId, slots }) => {
    const availableSlots = slots.filter((slot: any) => slot.isAvailable);
    let apiSlots = availableSlots
      .map((slot: any) => ({
        start: slot.time,
        end: addMinutesToTime(slot.time, 30),
        date,
      }))
      .filter((slot) => {
        const slotEndDateTime = new Date(`${date}T${slot.end}`);
        const now = new Date();
        return slotEndDateTime > now;
      });

    apiSlots = mergeConsecutiveSlots(apiSlots);

    // Only use fallback if no real slots are available
    let allSlots = [...apiSlots];
    
    if (allSlots.length === 0 && date === format(new Date(), "yyyy-MM-dd") && tenantSettings?.operatingHours) {
      // Only generate fallback slots if there are truly no available slots
      const now = new Date();
      const closeTime = tenantSettings.operatingHours.close || "20:00";
      const openTime = tenantSettings.operatingHours.open || "09:00";
      const closeMinutes = timeToMinutes(closeTime);
      const openMinutes = timeToMinutes(openTime);
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const startMinutes = Math.max(
        openMinutes,
        Math.ceil(currentMinutes / 15) * 15,
      );

      const fallbackSlots: any[] = [];
      for (let start = startMinutes; start < closeMinutes; start += 15) {
        const end = Math.min(start + 15, closeMinutes);
        fallbackSlots.push({
          start: minutesToTime(start),
          end: minutesToTime(end),
          date,
        });
      }
      
      allSlots = mergeConsecutiveSlots(fallbackSlots);
    }

    if (existingAppointments.length > 0 && allSlots.length === 0) {
      console.warn(
        `Prof ${profId} on ${date}: ${apiSlots.length} API slots = ${allSlots.length} total`,
      );
    }

    availability[profId] = allSlots;

    if (allSlots.length === 0) {
      warnings.push(`Professional ${profId} has no available slots`);
    }
  });

  return { availability, warnings, date };
}

/**
 * Merge consecutive available time slots into longer blocks
 */
function mergeConsecutiveSlots(slots: any[]): any[] {
  if (!slots || slots.length === 0) return [];

  // Sort slots by start time
  const sortedSlots = [...slots].sort(
    (a, b) => timeToMinutes(a.start) - timeToMinutes(b.start),
  );

  const merged: any[] = [];
  let current = sortedSlots[0];

  for (let i = 1; i < sortedSlots.length; i++) {
    const next = sortedSlots[i];

    if (
      timeToMinutes(next.start) === timeToMinutes(current.end) &&
      next.date === current.date
    ) {
      // Merge: extend current end to next end
      current.end = next.end;
    } else {
      merged.push(current);
      current = next;
    }
  }

  merged.push(current);
  return merged;
}

/**
 * Get tenant settings including setup time configuration
 */
export async function getTenantSettings(apiClient: any) {
  try {
    const tenant = await apiClient.getTenant();
    return {
      setupTime: (tenant as any).appointmentSetupTime || 5,
      timezone: tenant.timezone || "UTC",
      operatingHours: (tenant as any).operatingHours || {
        open: "09:00",
        close: "20:00",
      },
    };
  } catch (error) {
    console.error("Error fetching tenant settings:", error);
    return {
      setupTime: 5,
      timezone: "UTC",
      operatingHours: { open: "09:00", close: "20:00" },
    };
  }
}

/**
 * Transform algorithm results to UI-friendly format
 */
export function transformOptionsForUI(rawOptions: any[], fallbackDate: string) {
  return rawOptions.map((option) => {
    const optionDate = option.date || fallbackDate;
    const dateObj = new Date(optionDate);
    const dayName = dateObj.toLocaleDateString("en-US", { weekday: "long" });
    const day = dateObj.getDate().toString().padStart(2, "0");
    const month = (dateObj.getMonth() + 1).toString().padStart(2, "0");
    const formattedDate = `${dayName}, ${day}/${month}`;

    return {
      id: option.id,
      title: option.label,
      recommended: option.priority === 1,
      startTime: option.startTime,
      endTime: option.endTime,
      duration: option.totalDuration,
      noWaiting: option.waitTime === 0,
      date: optionDate,
      formattedDate,
      timeline: option.schedule.map((sched: any) => ({
        type: "service",
        service: sched.serviceName,
        professional: sched.professionalName,
        startTime: sched.startTime,
        endTime: sched.endTime,
      })),
    };
  });
}

/**
 * TIME UTILITY FUNCTIONS
 */

export function addMinutesToTime(timeStr: string, minutes: number): string {
  const totalMinutes = timeToMinutes(timeStr) + minutes;
  return minutesToTime(totalMinutes);
}

export function timeToMinutes(timeStr: string): number {
  if (!timeStr || typeof timeStr !== "string") return 0;
  const [hours, minutes] = timeStr.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

export function minutesToTime(minutes: number): string {
  if (typeof minutes !== "number" || isNaN(minutes)) return "00:00";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

export function isWithinOperatingHours(
  timeStr: string,
  operatingHours = { open: "09:00", close: "20:00" },
) {
  const time = timeToMinutes(timeStr);
  const open = timeToMinutes(operatingHours.open);
  const close = timeToMinutes(operatingHours.close);
  return time >= open && time <= close;
}

/**
 * CACHE UTILITIES
 */

const availabilityCache = new Map();
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

export class AvailabilityCache {
  static get(key: string) {
    const cached = availabilityCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > CACHE_DURATION) {
      availabilityCache.delete(key);
      return null;
    }
    return cached;
  }

  static set(key: string, data: any) {
    availabilityCache.set(key, { data, timestamp: Date.now() });
  }

  static clear() {
    availabilityCache.clear();
  }

  static invalidateByDate(date: string) {
    for (const key of Array.from(availabilityCache.keys())) {
      if (key.includes(date)) availabilityCache.delete(key);
    }
  }
}

export function generateAvailabilityCacheKey(
  date: string,
  professionalIds: string[],
) {
  return `availability_${date}_${professionalIds.sort().join(",")}`;
}

/**
 * VALIDATION FUNCTIONS
 */

export function validateServicesForScheduling(services: any[]) {
  const errors: string[] = [];
  if (!services || services.length === 0) {
    errors.push("No services selected");
  }
  services.forEach((service, index) => {
    if (!service.id) errors.push(`Service ${index + 1}: Missing service ID`);
    if (!service.name)
      errors.push(`Service ${index + 1}: Missing service name`);
    if (!service.duration || service.duration <= 0)
      errors.push(`Service ${index + 1}: Invalid duration`);
    if (!service.professionalId)
      errors.push(`Service ${index + 1}: No professional assigned`);
  });
  return { isValid: errors.length === 0, errors };
}

export function validateAvailabilityData(
  availability: ProfessionalAvailability,
  requiredProfessionalIds: string[],
) {
  const errors: string[] = [];
  const warnings: string[] = [];
  requiredProfessionalIds.forEach((profId) => {
    if (!availability[profId]) {
      errors.push(`No availability data for professional ${profId}`);
    } else if (availability[profId].length === 0) {
      warnings.push(`Professional ${profId} has no available slots`);
    }
  });
  return { isValid: errors.length === 0, errors, warnings };
}

/**
 * Fetch availability for multiple days (used for specific time searches)
 */
export async function fetchMultiDayAvailability(
  startDate: string,
  professionalIds: string[],
  apiClient: any,
  serviceIds: string[] = [],
  daysToFetch: number = 3,
  tenantSettings?: any,
): Promise<{ availability: ProfessionalAvailability; warnings: string[] }> {
  if (!professionalIds || professionalIds.length === 0) {
    return { availability: {}, warnings: [] };
  }

  try {
    const allAvailability: ProfessionalAvailability = {};
    const allWarnings: string[] = [];

    professionalIds.forEach((profId) => {
      allAvailability[profId] = [];
    });

    const fetchPromises = [];
    for (let dayOffset = 0; dayOffset < daysToFetch; dayOffset++) {
      const currentDate = new Date(startDate);
      currentDate.setDate(currentDate.getDate() + dayOffset);
      const dateString = currentDate.toISOString().split("T")[0];

      fetchPromises.push(
        fetchProfessionalAvailability(
          dateString,
          professionalIds,
          apiClient,
          serviceIds,
          tenantSettings,
        ),
      );
    }

    const dayResults = await Promise.all(fetchPromises);

    dayResults.forEach((dayResult) => {
      professionalIds.forEach((profId) => {
        const daySlots = (dayResult.availability ?? {})[profId] || [];
        const slotsWithDate = daySlots.map((slot: any) => ({
          ...slot,
          date: dayResult.date,
        }));
        allAvailability[profId].push(...slotsWithDate);
      });

      allWarnings.push(
        ...(dayResult.warnings ?? [])
          .filter(
            (warning: string) =>
              !warning.includes("has no available slots") ||
              dayResult.date === startDate,
          )
          .map((warning: string) => `${warning} (${dayResult.date})`),
      );
    });

    professionalIds.forEach((profId) => {
      if (allAvailability[profId].length === 0) {
        allWarnings.push(`Professional ${profId} has no available slots`);
      }
    });

    const uniqueWarnings = [...new Set(allWarnings)];

    return { availability: allAvailability, warnings: uniqueWarnings };
  } catch (error) {
    console.error("Error fetching multi-day availability:", error);
    return {
      availability: {},
      warnings: ["Error fetching availability data"],
    };
  }
}
