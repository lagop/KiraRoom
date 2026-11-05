import React from "react";
import { AlertCircle, Calendar, CheckCircle, Search } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import { formatDateString } from "../../appointment-drawer.utils";
import type { SlotSuggestion } from "../../slot-suggestions";
import type { SuggestionsError } from "../hooks/useAppointmentSuggestions";

/**
 * The free times the server offers for the new appointment (see
 * useAppointmentSuggestions), a button to look again, and what to do when
 * nothing is free. Picking one fills in the day, the time and, for
 * "anyone", the professional who is free then.
 */
export interface AppointmentSuggestionsSectionProps {
  /** A service and a time preference are chosen: there is something to look for. */
  ready: boolean;
  /** The visit has more than one service: only the first is checked here. */
  severalServices: boolean;
  appointmentSuggestions: SlotSuggestion[];
  selectedSuggestion: SlotSuggestion | null;
  suggestionsLoading: boolean;
  suggestionsError: SuggestionsError | null;
  searched: boolean;
  specificSearch: boolean;
  onGenerate: () => void;
  onSelect: (suggestion: SlotSuggestion) => void;
}

export function AppointmentSuggestionsSection({
  ready,
  severalServices,
  appointmentSuggestions,
  selectedSuggestion,
  suggestionsLoading,
  suggestionsError,
  searched,
  specificSearch,
  onGenerate,
  onSelect,
}: AppointmentSuggestionsSectionProps) {
  const t = useTranslations();
  if (!ready) return null;

  const hasSuggestions = appointmentSuggestions.length > 0;
  const nothingFree = searched && !suggestionsLoading && !suggestionsError && !hasSuggestions;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h3 className="text-lg font-semibold text-gray-900 flex items-center">
          <Calendar className="w-5 h-5 mr-2 text-indigo-600" />
          {t("appointments.appointment_suggestions")}
        </h3>
        <button
          type="button"
          onClick={onGenerate}
          disabled={suggestionsLoading}
          className="inline-flex items-center px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
        >
          <Search className="w-4 h-4 mr-2" />
          {t("appointments.suggestions.findTimes")}
        </button>
      </div>

      {severalServices && (
        <p className="text-xs text-gray-500 mb-3">{t("appointments.suggestions.firstServiceOnly")}</p>
      )}

      {suggestionsLoading && (
        <div className="flex items-center justify-center py-6">
          <div className="animate-spin w-6 h-6 border-4 border-indigo-500 border-t-transparent rounded-full mr-3" />
          <span className="text-gray-600">{t("appointments.suggestions.loading")}</span>
        </div>
      )}

      {suggestionsError && !suggestionsLoading && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start">
          <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0" />
          <span>
            {t("appointments.suggestions.failed")}
            {suggestionsError.message ? ` ${suggestionsError.message}` : ""}
          </span>
        </div>
      )}

      {nothingFree && (
        <div className="text-center py-6 text-gray-500">
          <p className="font-medium text-gray-700 mb-1">
            {specificSearch
              ? t("appointments.suggestions.noneSpecific")
              : t("appointments.suggestions.none")}
          </p>
          <p className="text-sm">{t("appointments.suggestions.noneHint")}</p>
        </div>
      )}

      {!suggestionsLoading && hasSuggestions && (
        <>
          <p className="text-sm text-gray-500 mb-3 first-letter:uppercase">
            {formatDateString(appointmentSuggestions[0].date)}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {appointmentSuggestions.map((suggestion) => {
              const selected = selectedSuggestion?.id === suggestion.id;
              return (
                <button
                  key={suggestion.id}
                  type="button"
                  onClick={() => onSelect(suggestion)}
                  aria-pressed={selected}
                  className={`text-left border-2 rounded-lg px-3 py-2 transition-all ${
                    selected
                      ? "border-indigo-600 bg-indigo-50"
                      : "border-gray-200 hover:border-indigo-300 hover:bg-gray-50"
                  }`}
                >
                  <span className="block font-semibold text-indigo-700">
                    {suggestion.startTime} – {suggestion.endTime}
                  </span>
                  {suggestion.professionalName && (
                    <span className="block text-sm text-gray-600 truncate">
                      {suggestion.professionalName}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {selectedSuggestion && (
            <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg flex items-center text-sm text-green-700">
              <CheckCircle className="w-5 h-5 mr-2 flex-shrink-0" />
              {t("appointments.suggestions.selected", {
                date: formatDateString(selectedSuggestion.date),
                time: selectedSuggestion.startTime,
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
