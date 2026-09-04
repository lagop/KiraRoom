import { useCallback, useState } from "react";
import { format } from "date-fns";
import apiClient from "../../../../../../lib/api";
import { useTranslations } from "@/lib/use-translation";
import { addMinutesToTime, getProfessionalName, sumServiceDurations } from "../../appointment-drawer.utils";
import {
  generateFallbackSuggestions as buildFallbackSuggestions,
  type FallbackSuggestion,
} from "../../appointment-suggestions";
import {
  prepareServiceObjects,
  fetchProfessionalAvailability,
  fetchMultiDayAvailability,
  getTenantSettings,
  transformOptionsForUI,
  validateServicesForScheduling,
  validateAvailabilityData,
  AvailabilityCache,
  generateAvailabilityCacheKey,
  timeToMinutes,
} from "../../../../../../lib/appointment-scheduler.utils";
import { AppointmentScheduler } from "../../../../../../lib/appointment-scheduler";
import type { CatalogProfessional, CatalogService } from "./useAppointmentCatalog";
import type { SelectedService } from "./useAppointmentFormState";

/**
 * Appointment-suggestion engine.
 *
 * Owns:
 *   - `appointmentSuggestions`, `selectedSuggestion`            result state
 *   - `suggestionsLoading`, `suggestionsError`,
 *     `availabilityWarnings`                                    loading/error
 *   - `generateAppointmentSuggestions` (the smart async one)
 *   - `generateMockSuggestions`      (single placeholder row)
 *   - `generateFallbackSuggestions`   (delegates to the pure helper)
 *
 * The smart generator needs to read **a lot** of state from outside:
 * the catalog (services + professionals), the form state
 * (selectedServices, newAppointment.date, dateTimePreference), and
 * the translation function. To keep the hook small, those are passed
 * in as arguments to `generate()` rather than wired via React
 * context. The orchestrator stitches everything together.
 *
 * Verbatim move of `generateAppointmentSuggestions` (was lines
 * 211-472), `generateMockSuggestions` (was lines 479-530), and
 * `generateFallbackSuggestions` (was lines 536-551) from
 * `appointment-drawer.tsx`. No semantic changes — just lifted to a
 * hook that owns the suggestion state.
 */

export interface SuggestionInputs {
  selectedServices: SelectedService[];
  services: ReadonlyArray<CatalogService>;
  professionals: ReadonlyArray<CatalogProfessional>;
  newAppointmentDate: string;
  dateTimePreference: {
    type: string;
    morningPreferred: boolean;
    afternoonPreferred: boolean;
    specificDate: string;
    specificTime: string;
    specificTimePeriod: string;
  };
  setAutoAssignMap: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;
  // Optional callback used by the smart generator to drop the
  // appointment's addons into the form state after a successful run.
  // (Not used today — kept here for symmetry with the legacy inline
  // version that closed over `setCurrentAddons`.)
  onResolved?: (resolved: SelectedService[]) => void;
}

export interface UseAppointmentSuggestionsResult {
  appointmentSuggestions: any[];
  setAppointmentSuggestions: React.Dispatch<React.SetStateAction<any[]>>;
  selectedSuggestion: any | null;
  setSelectedSuggestion: React.Dispatch<React.SetStateAction<any | null>>;
  suggestionsLoading: boolean;
  suggestionsError: string | null;
  availabilityWarnings: string[];
  generate: (inputs: SuggestionInputs) => Promise<void>;
  generateMock: (inputs: Pick<SuggestionInputs, "selectedServices" | "services" | "professionals" | "newAppointmentDate">) => void;
  generateFallback: (preferenceType: string, inputs: Pick<SuggestionInputs, "selectedServices" | "services" | "professionals">) => void;
  clearSuggestions: () => void;
}

export function useAppointmentSuggestions(): UseAppointmentSuggestionsResult {
  const t = useTranslations();
  const [appointmentSuggestions, setAppointmentSuggestions] = useState<
    any[]
  >([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState<any | null>(
    null,
  );
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [availabilityWarnings, setAvailabilityWarnings] = useState<string[]>(
    [],
  );

  /**
   * Smart generator — runs the AppointmentScheduler with availability
   * fetched from the backend, validates the result, and falls back
   * to mock suggestions if anything goes wrong.
   *
   * Verbatim from appointment-drawer.tsx:211-472.
   */
  const generate = useCallback(
    async (inputs: SuggestionInputs): Promise<void> => {
      const {
        selectedServices,
        services,
        professionals,
        newAppointmentDate,
        dateTimePreference,
        setAutoAssignMap,
      } = inputs;

      const effectiveDateTimePreference = dateTimePreference.type
        ? dateTimePreference
        : { ...dateTimePreference, type: "next_available" };

      if (
        selectedServices.length === 0 ||
        !newAppointmentDate ||
        (effectiveDateTimePreference.type === "specific" &&
          (!effectiveDateTimePreference.specificDate ||
            !effectiveDateTimePreference.specificTimePeriod))
      ) {
        setAppointmentSuggestions([]);
        setSelectedSuggestion(null);
        setAvailabilityWarnings([]);
        return;
      }

      setSuggestionsLoading(true);
      setSuggestionsError(null);

      try {
        const autoAssignServices = selectedServices.filter(
          (s) => !s.professionalId,
        );
        const assignedProfIds = selectedServices
          .filter((s) => s.professionalId)
          .map((s) => s.professionalId!);

        let availabilityDate = newAppointmentDate;
        let isMultiDaySearch = false;

        if (
          effectiveDateTimePreference.type === "specific" &&
          effectiveDateTimePreference.specificDate
        ) {
          availabilityDate = effectiveDateTimePreference.specificDate;
          isMultiDaySearch = true;
        } else if (
          effectiveDateTimePreference.type === "next_available" ||
          !effectiveDateTimePreference.type
        ) {
          isMultiDaySearch = true;
          availabilityDate = format(new Date(), "yyyy-MM-dd");
        }

        const tenantSettings = await getTenantSettings(apiClient);

        const relevantProfessionals = professionals.filter((p) =>
          p.services?.some((ps) =>
            selectedServices.some((s) => s.serviceId === ps.serviceId),
          ),
        );
        const allProfIdsForAvailability = [
          ...new Set(relevantProfessionals.map((p) => p.id)),
        ];

        let availability: Record<string, unknown[]> = {};
        let warnings: string[] = [];
        setAvailabilityWarnings([]);

        if (allProfIdsForAvailability.length > 0) {
          if (isMultiDaySearch) {
            const multiDayResult = await fetchMultiDayAvailability(
              availabilityDate,
              allProfIdsForAvailability,
              apiClient,
              selectedServices.map((s) => s.serviceId),
              undefined,
              tenantSettings,
            );
            availability = multiDayResult.availability!;
            warnings = multiDayResult.warnings!;
            const cacheKey = generateAvailabilityCacheKey(
              availabilityDate,
              allProfIdsForAvailability,
            );
            AvailabilityCache.set(cacheKey, multiDayResult);
          } else {
            const result = await fetchProfessionalAvailability(
              availabilityDate,
              allProfIdsForAvailability,
              apiClient,
              selectedServices.map((s) => s.serviceId),
              tenantSettings,
            );
            availability = result.availability!;
            warnings = result.warnings!;
            const cacheKey = generateAvailabilityCacheKey(
              availabilityDate,
              allProfIdsForAvailability,
            );
            AvailabilityCache.set(cacheKey, result);
          }
          setAvailabilityWarnings(warnings);
        }

        function hasAvailability(profId: string): boolean {
          const slots = availability[profId] || [];
          return slots.length > 0;
        }

        const autoAssignCandidates: Map<string, string[]> = new Map();
        const candidateProfIds: string[] = [];

        autoAssignServices.forEach((svc) => {
          const qualifying = professionals.filter(
            (pro) =>
              pro.services?.some(
                (ps: { serviceId: string }) => ps.serviceId === svc.serviceId,
              ) &&
              hasAvailability(pro.id) &&
              !assignedProfIds.includes(pro.id),
          );
          const ids = qualifying.map((p) => p.id);
          autoAssignCandidates.set(svc.serviceId, ids);
          ids.forEach((id) => candidateProfIds.push(id));
        });

        const allProfessionalIds = [
          ...new Set([...assignedProfIds, ...candidateProfIds]),
        ];

        const newAutoAssignMap: Record<string, string> = {};
        let resolvedServices = [...selectedServices];

        if (autoAssignServices.length > 0) {
          const parallelAutoServices = autoAssignServices.filter(
            (s) => s.isParallel,
          );
          const serialAutoServices = autoAssignServices.filter(
            (s) => !s.isParallel,
          );
          const usedForParallel = new Set<string>(assignedProfIds);

          const getEarliestSlot = (profId: string): number => {
            const slots = (availability[profId] || []) as Array<{
              start: string;
            }>;
            if (slots.length === 0) return Infinity;
            return Math.min(
              ...slots.map((s) => timeToMinutes(s.start)),
            );
          };

          parallelAutoServices.forEach((svc) => {
            const candidates = (
              autoAssignCandidates.get(svc.serviceId) || []
            ).filter((id) => !usedForParallel.has(id));
            if (candidates.length === 0) return;

            const sortedCandidates = [...candidates].sort(
              (a: string, b: string) => {
                const aTime = getEarliestSlot(a);
                const bTime = getEarliestSlot(b);
                if (aTime !== bTime) return aTime - bTime;
                return a.localeCompare(b);
              },
            );
            const selectedProf = sortedCandidates[0];
            const selectedTime = getEarliestSlot(selectedProf);
            newAutoAssignMap[svc.serviceId] = selectedProf;
            usedForParallel.add(selectedProf);
          });

          serialAutoServices.forEach((svc) => {
            const candidates = autoAssignCandidates.get(svc.serviceId) || [];
            if (candidates.length === 0) return;

            const sortedCandidates = [...candidates].sort(
              (a: string, b: string) => {
                const aTime = getEarliestSlot(a);
                const bTime = getEarliestSlot(b);
                if (aTime !== bTime) return aTime - bTime;
                return a.localeCompare(b);
              },
            );
            const selectedProf = sortedCandidates[0];
            newAutoAssignMap[svc.serviceId] = selectedProf;
          });

          resolvedServices = selectedServices.map((svc) => {
            if (svc.professionalId) return svc;
            const resolved = newAutoAssignMap[svc.serviceId];
            return resolved ? { ...svc, professionalId: resolved } : svc;
          });
          setAutoAssignMap(newAutoAssignMap);
        }

        const unresolvedCount = resolvedServices.filter(
          (s) => !s.professionalId,
        ).length;
        if (unresolvedCount > 0) {
          setSuggestionsError(
            "Could not assign professionals to all services. Please assign manually.",
          );
          setAppointmentSuggestions([]);
          setAvailabilityWarnings([]);
          setSelectedSuggestion(null);
          return;
        }

        const serviceObjects = prepareServiceObjects(
          resolvedServices,
          services as any,
          professionals as any,
        );

        const serviceValidation =
          validateServicesForScheduling(serviceObjects);
        if (!serviceValidation.isValid) {
          setSuggestionsError(
            "Invalid service configuration. Please check service assignments.",
          );
          setAppointmentSuggestions([]);
          return;
        }

        const resolvedProfIds = [
          ...new Set(
            resolvedServices.map((s) => s.professionalId!).filter(Boolean),
          ),
        ];
        const availabilityValidation = validateAvailabilityData(
          availability,
          resolvedProfIds,
        );
        if (!availabilityValidation.isValid) {
          setSuggestionsError(
            "Unable to retrieve professional availability. Please try again.",
          );
          setAppointmentSuggestions([]);
          setAvailabilityWarnings([]);
          return;
        }

        const scheduler = new AppointmentScheduler(
          tenantSettings.operatingHours,
          tenantSettings.setupTime,
        );

        const rawOptions = scheduler.generateScheduleOptions(
          serviceObjects,
          availability,
          new Date(availabilityDate),
          effectiveDateTimePreference,
        );

        if (typeof rawOptions === "object" && "error" in rawOptions) {
          setSuggestionsError(rawOptions.error as string);
          // Fall back to mock (mirrors the inline call site's behavior)
          const mock = generateMockInternal({
            selectedServices,
            services: services as any,
            professionals: professionals as any,
            newAppointmentDate,
            dateTimePreference,
          });
          setAppointmentSuggestions(mock ? [mock] : []);
          return;
        }

        if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
          generateFallbackInternal({
            preferenceType: effectiveDateTimePreference.type,
            selectedServices,
            services: services as any,
            professionals: professionals as any,
          });
          return;
        }

        const uiOptions = transformOptionsForUI(
          rawOptions,
          availabilityDate,
        );
        setAppointmentSuggestions(uiOptions);
      } catch (error) {
        setSuggestionsError(
          "Failed to generate appointment suggestions. Using basic options.",
        );
        const mock = generateMockInternal({
          selectedServices,
          services: services as any,
          professionals: professionals as any,
          newAppointmentDate,
          dateTimePreference,
        });
        setAppointmentSuggestions(mock ? [mock] : []);
      } finally {
        setSuggestionsLoading(false);
      }
    },
    [],
  );

  // --- Internal helpers (used by `generate`) ---

  function generateMockInternal(inputs: {
    selectedServices: SelectedService[];
    services: ReadonlyArray<CatalogService>;
    professionals: ReadonlyArray<CatalogProfessional>;
    newAppointmentDate: string;
    dateTimePreference: { type: string; specificTimePeriod?: string };
  }) {
    const { selectedServices, services, professionals, newAppointmentDate, dateTimePreference } = inputs;
    if (selectedServices.length === 0) {
      setAppointmentSuggestions([]);
      return null;
    }
    const totalDuration = sumServiceDurations(selectedServices, services);

    let baseTime = "09:00";
    if (
      dateTimePreference.type === "specific" &&
      dateTimePreference.specificTimePeriod
    ) {
      if (dateTimePreference.specificTimePeriod === "morning") {
        baseTime = "10:00";
      } else if (dateTimePreference.specificTimePeriod === "evening") {
        baseTime = "17:00";
      } else {
        baseTime = dateTimePreference.specificTimePeriod;
      }
    }

    return {
      id: "quickest_fallback",
      title: "Quickest",
      recommended: true,
      startTime: baseTime,
      endTime: addMinutesToTime(baseTime, totalDuration),
      duration: totalDuration,
      noWaiting: true,
      date: newAppointmentDate,
      timeline: selectedServices.map((sel) => {
        const service = services.find((s) => s.id === sel.serviceId);
        const duration = Number(service?.duration) || 60;
        return {
          type: "service",
          service: service?.name ?? "Service",
          professional: getProfessionalName(sel.professionalId, professionals),
          startTime: baseTime,
          endTime: addMinutesToTime(baseTime, duration),
        };
      }),
    };
  }

  function generateFallbackInternal(inputs: {
    preferenceType: string;
    selectedServices: SelectedService[];
    services: ReadonlyArray<CatalogService>;
    professionals: ReadonlyArray<CatalogProfessional>;
  }) {
    const generated: FallbackSuggestion[] = buildFallbackSuggestions({
      preferenceType: inputs.preferenceType,
      selectedServices: inputs.selectedServices,
      services: inputs.services as any,
      professionals: inputs.professionals as any,
      labels: {
        today: t("pos_today"),
        tomorrow: t("pos_tomorrow"),
      },
    });
    setAppointmentSuggestions(generated);
  }

  // --- Public wrappers (callable from outside the smart generator) ---

  const generateMock = useCallback(
    (inputs: {
      selectedServices: SelectedService[];
      services: ReadonlyArray<CatalogService>;
      professionals: ReadonlyArray<CatalogProfessional>;
      newAppointmentDate: string;
    }) => {
      const mock = generateMockInternal({
        ...inputs,
        dateTimePreference: { type: "" },
      });
      setAppointmentSuggestions(mock ? [mock] : []);
    },
    [],
  );

  const generateFallback = useCallback(
    (
      preferenceType: string,
      inputs: {
        selectedServices: SelectedService[];
        services: ReadonlyArray<CatalogService>;
        professionals: ReadonlyArray<CatalogProfessional>;
      },
    ) => {
      generateFallbackInternal({
        preferenceType,
        ...inputs,
      });
    },
    [],
  );

  const clearSuggestions = useCallback(() => {
    setAppointmentSuggestions([]);
    setSelectedSuggestion(null);
    setAvailabilityWarnings([]);
    setSuggestionsError(null);
  }, []);

  return {
    appointmentSuggestions,
    setAppointmentSuggestions,
    selectedSuggestion,
    setSelectedSuggestion,
    suggestionsLoading,
    suggestionsError,
    availabilityWarnings,
    generate,
    generateMock,
    generateFallback,
    clearSuggestions,
  };
}