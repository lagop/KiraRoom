/**
 * Fallback appointment-suggestion generator, extracted from
 * `appointment-drawer.tsx`.
 *
 * Pure function: takes a preference + the catalog of selected
 * services / professionals and returns the suggestion array the
 * drawer stores in state. No React, no API, no Date.now()
 * side effects — the caller passes `now` so tests are
 * deterministic.
 *
 * When the smart scheduler (AppointmentScheduler in
 * lib/appointment-scheduler) has nothing to suggest, this module
 * produces 3-4 placeholder suggestions so the UI never renders
 * the empty state.
 *
 * Mirrors the production behaviour:
 *   - "next_available"     → 4 slots tomorrow at 10/11/14/15
 *   - "today_morning"      → 4 slots 09:00–10:30 on today or tomorrow
 *   - "today_afternoon"    → 4 slots 14:00–15:30 on today or tomorrow
 *   - "flexible"           → 4 slots 09:30–15:30 tomorrow
 *   - <other>              → 3 generic slots tomorrow
 *
 * Returns at most 4 suggestions.
 */

import {
  addMinutesToTime,
  formatIsoDate,
  getProfessionalName,
  sumServiceDurations,
} from "./appointment-drawer.utils";

export type PreferenceType =
  | "next_available"
  | "today_morning"
  | "today_afternoon"
  | "flexible"
  | (string & {});

export interface FallbackService {
  id: string;
  name: string;
  duration?: number | null;
}

export interface FallbackProfessional {
  id: string;
  firstName: string;
  lastName: string;
}

export interface FallbackSelectedService {
  serviceId: string;
  professionalId?: string;
}

export interface FallbackSuggestion {
  id: string;
  title: string;
  recommended: boolean;
  startTime: string;
  endTime: string;
  duration: number;
  noWaiting: boolean;
  date: string;
  formattedDate: string;
  timeline: Array<{
    type: string;
    service: string;
    professional: string;
    startTime: string;
    endTime: string;
  }>;
}

export interface FallbackParams {
  preferenceType: PreferenceType;
  selectedServices: ReadonlyArray<FallbackSelectedService>;
  services: ReadonlyArray<FallbackService>;
  professionals: ReadonlyArray<FallbackProfessional>;
  /**
   * Localized labels for "Today" / "Tomorrow" etc. Defaults to
   * Spanish ("Hoy" / "Mañana") to match the original drawer's
   * hard-coded `t('pos_today')` / `t('pos_tomorrow')` fallback
   * labels. The component passes the live `t()` output in production.
   */
  labels?: {
    today?: string;
    tomorrow?: string;
  };
  /**
   * Injected for testability. Defaults to `new Date()` in
   * production callers but tests pin a fixed instant.
   */
  now?: Date;
}

const NEXT_AVAILABLE_TIMES = ["10:00", "11:00", "14:00", "15:00"];
const MORNING_TIMES = ["09:00", "09:30", "10:00", "10:30"];
const AFTERNOON_TIMES = ["14:00", "14:30", "15:00", "15:30"];
const FLEXIBLE_TIMES = ["09:30", "11:00", "14:00", "15:30"];
const FLEXIBLE_LABELS = [
  "Morning Early",
  "Late Morning",
  "Early Afternoon",
  "Late Afternoon",
];
const GENERIC_TIMES = ["10:00", "11:00", "14:00"];

const DEFAULT_LABELS = {
  today: "Hoy",
  tomorrow: "Mañana",
};

/**
 * Format a Date as the drawer's locale-aware display string
 * (e.g. "Monday, 17/03"). Encapsulates the toLocaleDateString +
 * dd/mm padding used by every suggestion row.
 */
function formatDisplayDate(date: Date): string {
  return `${date.toLocaleDateString("en-US", { weekday: "long" })}, ${date
    .getDate()
    .toString()
    .padStart(2, "0")}/${(date.getMonth() + 1).toString().padStart(2, "0")}`;
}

function buildTimeline(
  selectedServices: ReadonlyArray<FallbackSelectedService>,
  services: ReadonlyArray<FallbackService>,
  professionals: ReadonlyArray<FallbackProfessional>,
  startTime: string,
): FallbackSuggestion["timeline"] {
  return selectedServices.map((sel) => {
    const service = services.find((s) => s.id === sel.serviceId);
    const duration = Number(service?.duration) || 60;
    return {
      type: "service",
      service: service?.name ?? "Service",
      professional: getProfessionalName(sel.professionalId, professionals),
      startTime,
      endTime: addMinutesToTime(startTime, duration),
    };
  });
}

function buildSuggestion(
  id: string,
  title: string,
  recommended: boolean,
  startTime: string,
  totalDuration: number,
  date: Date,
  selectedServices: ReadonlyArray<FallbackSelectedService>,
  services: ReadonlyArray<FallbackService>,
  professionals: ReadonlyArray<FallbackProfessional>,
): FallbackSuggestion {
  return {
    id,
    title,
    recommended,
    startTime,
    endTime: addMinutesToTime(startTime, totalDuration),
    duration: totalDuration,
    noWaiting: true,
    date: formatIsoDate(date),
    formattedDate: formatDisplayDate(date),
    timeline: buildTimeline(
      selectedServices,
      services,
      professionals,
      startTime,
    ),
  };
}

/**
 * Generate 3-4 placeholder suggestions. Pure function — pass an
 * explicit `now` for tests.
 */
export function generateFallbackSuggestions(
  params: FallbackParams,
): FallbackSuggestion[] {
  const labels = { ...DEFAULT_LABELS, ...(params.labels ?? {}) };
  const now = params.now ?? new Date();

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const totalDuration = sumServiceDurations(params.selectedServices, params.services);

  const suggestions: FallbackSuggestion[] = [];

  switch (params.preferenceType) {
    case "next_available":
      NEXT_AVAILABLE_TIMES.forEach((time, index) => {
        suggestions.push(
          buildSuggestion(
            `fallback_next_${index + 1}`,
            index === 0 ? "Próximo Disponible" : `Opción ${index + 1}`,
            index === 0,
            time,
            totalDuration,
            tomorrow,
            params.selectedServices,
            params.services,
            params.professionals,
          ),
        );
      });
      break;

    case "today_morning": {
      const isMorning = now.getHours() < 12;
      const targetDate = isMorning ? today : tomorrow;
      const dateLabel = isMorning ? labels.today : labels.tomorrow;
      MORNING_TIMES.forEach((time, index) => {
        suggestions.push(
          buildSuggestion(
            `fallback_morning_${index + 1}`,
            index === 0
              ? `${dateLabel} Morning`
              : `Morning Option ${index + 1}`,
            index === 0,
            time,
            totalDuration,
            targetDate,
            params.selectedServices,
            params.services,
            params.professionals,
          ),
        );
      });
      break;
    }

    case "today_afternoon": {
      const currentHour = now.getHours();
      const targetDate = currentHour < 16 ? today : tomorrow;
      const dateLabel = currentHour < 16 ? labels.today : labels.tomorrow;
      AFTERNOON_TIMES.forEach((time, index) => {
        suggestions.push(
          buildSuggestion(
            `fallback_afternoon_${index + 1}`,
            index === 0
              ? `${dateLabel} Afternoon`
              : `Afternoon Option ${index + 1}`,
            index === 0,
            time,
            totalDuration,
            targetDate,
            params.selectedServices,
            params.services,
            params.professionals,
          ),
        );
      });
      break;
    }

    case "flexible":
      FLEXIBLE_TIMES.forEach((time, index) => {
        suggestions.push(
          buildSuggestion(
            `fallback_flexible_${index + 1}`,
            index === 0
              ? "Flexible Option"
              : `${FLEXIBLE_LABELS[index]} (Flexible)`,
            index === 0,
            time,
            totalDuration,
            tomorrow,
            params.selectedServices,
            params.services,
            params.professionals,
          ),
        );
      });
      break;

    default:
      GENERIC_TIMES.forEach((time, index) => {
        suggestions.push(
          buildSuggestion(
            `fallback_generic_${index + 1}`,
            index === 0 ? "Available Appointment" : `Option ${index + 1}`,
            index === 0,
            time,
            totalDuration,
            tomorrow,
            params.selectedServices,
            params.services,
            params.professionals,
          ),
        );
      });
  }

  return suggestions.slice(0, 4);
}