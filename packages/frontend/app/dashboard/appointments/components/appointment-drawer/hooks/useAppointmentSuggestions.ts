import { useCallback, useRef, useState } from "react";
import apiClient from "../../../../../../lib/api";
import { getCurrentUser } from "../../../../../../lib/utils";
import { localDay } from "../../../../../../components/Calendar/day-grid";
import { serverMessage } from "../../appointment-drawer.utils";
import {
  buildSlotSuggestions,
  candidateProfessionals,
  freeTimes,
  planSlotSearch,
  type ProfessionalSlots,
  type SlotSuggestion,
  type TimePreference,
} from "../../slot-suggestions";
import type { CatalogProfessional } from "./useAppointmentCatalog";
import type { SelectedService } from "./useAppointmentFormState";

/**
 * Suggested times for a new appointment, from the server's free slots
 * (GET /appointments/available-slots): see slot-suggestions.ts.
 *
 * The first service of the visit is checked, with its professional when
 * one is chosen, or anyone who offers it. For "anyone", each day is first
 * asked about as a whole (one request), and only the day with room is asked
 * per professional, to know who is free at each time.
 *
 * Only the newest search lands: a slower answer to an older one (the form
 * changed meanwhile) is dropped.
 */

export interface SuggestionInputs {
  selectedServices: SelectedService[];
  professionals: ReadonlyArray<CatalogProfessional>;
  preference: TimePreference;
  /** The visit's length, for the end time shown. */
  durationMinutes: number;
}

export interface SuggestionsError {
  /** The server's reason, when it gave one. */
  message?: string;
}

export interface UseAppointmentSuggestionsResult {
  appointmentSuggestions: SlotSuggestion[];
  selectedSuggestion: SlotSuggestion | null;
  setSelectedSuggestion: React.Dispatch<React.SetStateAction<SlotSuggestion | null>>;
  suggestionsLoading: boolean;
  suggestionsError: SuggestionsError | null;
  /** A search has finished since the last clear: "nothing free" rather than "not asked yet". */
  searched: boolean;
  generate: (inputs: SuggestionInputs) => Promise<void>;
  clearSuggestions: () => void;
}

export function useAppointmentSuggestions(): UseAppointmentSuggestionsResult {
  const [appointmentSuggestions, setAppointmentSuggestions] = useState<SlotSuggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState<SlotSuggestion | null>(null);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<SuggestionsError | null>(null);
  const [searched, setSearched] = useState(false);
  const latest = useRef(0);

  const generate = useCallback(async (inputs: SuggestionInputs): Promise<void> => {
    const request = ++latest.current;
    const stale = () => request !== latest.current;

    const first = inputs.selectedServices.find((s) => s.serviceId);
    const today = localDay();
    const search = planSlotSearch(inputs.preference, today);
    const tenantId = getCurrentUser()?.tenantId as string | undefined;
    setSelectedSuggestion(null);
    if (!first || !search || !tenantId) {
      setAppointmentSuggestions([]);
      setSuggestionsError(null);
      setSearched(false);
      setSuggestionsLoading(false);
      return;
    }

    setSuggestionsLoading(true);
    setSuggestionsError(null);
    try {
      const serviceId = first.serviceId;
      const chosenId = first.professionalId || undefined;
      const candidates: ProfessionalSlots[] = candidateProfessionals(
        inputs.professionals,
        serviceId,
        chosenId,
      ).map((p) => ({ professionalId: p.id, name: `${p.firstName} ${p.lastName}`.trim(), times: [] }));
      if (chosenId && candidates.length === 0) {
        candidates.push({ professionalId: chosenId, name: "", times: [] });
      }

      const ask = async (professionalId: string, day: string) =>
        freeTimes(await apiClient.getAvailableSlots(tenantId, professionalId, serviceId, day));
      const clock = new Date();
      const now = { day: today, minutes: clock.getHours() * 60 + clock.getMinutes() };

      let found: SlotSuggestion[] = [];
      for (const day of search.days) {
        let byProfessional: ProfessionalSlots[];
        if (candidates.length <= 1) {
          // One professional (or none recorded): ask for them directly.
          const only = candidates[0];
          byProfessional = [
            only
              ? { ...only, times: await ask(only.professionalId, day) }
              : { professionalId: "", name: "", times: await ask("", day) },
          ];
        } else {
          // Anyone who offers it: is there room at all that day? Then who.
          const anyone = await ask("", day);
          if (stale()) return;
          const room = buildSlotSuggestions({
            day,
            search,
            now,
            durationMinutes: inputs.durationMinutes,
            byProfessional: [{ professionalId: "", name: "", times: anyone }],
          });
          if (room.length === 0) continue;
          byProfessional = await Promise.all(
            candidates.map(async (c) => ({ ...c, times: await ask(c.professionalId, day) })),
          );
        }
        if (stale()) return;
        found = buildSlotSuggestions({
          day,
          search,
          now,
          durationMinutes: inputs.durationMinutes,
          byProfessional,
        });
        if (found.length > 0) break;
      }
      if (stale()) return;
      setAppointmentSuggestions(found);
      setSearched(true);
    } catch (error) {
      if (stale()) return;
      console.error("Failed to load free slots:", error);
      setAppointmentSuggestions([]);
      setSuggestionsError({ message: serverMessage(error) });
      setSearched(true);
    } finally {
      if (!stale()) setSuggestionsLoading(false);
    }
  }, []);

  const clearSuggestions = useCallback(() => {
    // Also drops an answer still on its way.
    latest.current += 1;
    setAppointmentSuggestions([]);
    setSelectedSuggestion(null);
    setSuggestionsError(null);
    setSuggestionsLoading(false);
    setSearched(false);
  }, []);

  return {
    appointmentSuggestions,
    selectedSuggestion,
    setSelectedSuggestion,
    suggestionsLoading,
    suggestionsError,
    searched,
    generate,
    clearSuggestions,
  };
}
