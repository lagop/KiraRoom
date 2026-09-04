import React from "react";
import { AlertCircle, Calendar, CheckCircle, Search } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import type { SelectedService } from "../hooks/useAppointmentFormState";
import type { CatalogProfessional, CatalogService } from "../hooks/useAppointmentCatalog";

/**
 * Renders the create-mode "Find Available Times" button + the
 * suggestion list once generated. Verbatim move from
 * `appointment-drawer.tsx:1409-1573` plus the empty-state fallback
 * (1582-...).
 *
 * The section is shown when the user has enough context to ask for
 * suggestions: either a multi-service entry in `selectedServices` OR
 * a single-service entry (`newAppointment.serviceId`) in
 * single-service mode, AND a `dateTimePreference.type` chosen.
 * The "Find Available Times" button also requires `newAppointmentDate`.
 */
export interface AppointmentSuggestionsSectionProps {
  selectedServices: SelectedService[];
  services: ReadonlyArray<CatalogService>;
  professionals: ReadonlyArray<CatalogProfessional>;
  newAppointmentDate: string;
  dateTimePreferenceType: string;
  appointmentSuggestions: any[];
  selectedSuggestion: any | null;
  suggestionsLoading: boolean;
  suggestionsError: string | null;
  availabilityWarnings: string[];
  /**
   * Single-service mode. When `newAppointment.serviceId` is set
   * (regardless of `selectedServices`), the section is allowed to
   * render. This was the missing piece that caused the section to
   * stay hidden in the normal new-appointment flow.
   */
  hasSingleServiceContext?: boolean;
  onGenerate: () => Promise<void>;
  onSelect: (suggestion: any) => void;
}

export function AppointmentSuggestionsSection({
  selectedServices,
  newAppointmentDate,
  dateTimePreferenceType,
  appointmentSuggestions,
  selectedSuggestion,
  suggestionsLoading,
  suggestionsError,
  availabilityWarnings,
  hasSingleServiceContext = false,
  onGenerate,
  onSelect,
}: AppointmentSuggestionsSectionProps) {
  const t = useTranslations();

  if (
    (selectedServices.length === 0 && !hasSingleServiceContext) ||
    !dateTimePreferenceType
  ) {
    return null;
  }

  const hasSuggestions = appointmentSuggestions.length > 0;

  return (
    <>
      {/* Find Available Times Button */}
      {!hasSuggestions && !suggestionsLoading && newAppointmentDate && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
          <button
            onClick={onGenerate}
            className="w-full inline-flex items-center justify-center px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
          >
            <Search className="w-4 h-4 mr-2" />
            Find Available Times
          </button>
        </div>
      )}

      {/* Suggestions block */}
      {(hasSuggestions || suggestionsLoading || suggestionsError) && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
            <Calendar className="w-5 h-5 mr-2 text-indigo-600" />
            {t("appointments.appointment_suggestions")}
          </h3>

          {/* Availability warnings */}
          {availabilityWarnings.length > 0 && !suggestionsLoading && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <div className="flex items-start">
                <AlertCircle className="w-5 h-5 mr-2 text-amber-600 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium text-amber-800 mb-1">
                    Availability Notice:
                  </p>
                  <ul className="text-amber-700 space-y-1">
                    {availabilityWarnings.map((warning, index) => (
                      <li key={index}>• {warning}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Loading */}
          {suggestionsLoading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-6 h-6 border-4 border-indigo-500 border-t-transparent rounded-full mr-3" />
              <span className="text-gray-600">
                Generating optimal appointment options...
              </span>
            </div>
          )}

          {/* Error — always rendered when present, even if no suggestions yet. */}
          {suggestionsError && !suggestionsLoading && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-center text-red-700">
                <AlertCircle className="w-5 h-5 mr-2" />
                <span>{suggestionsError}</span>
              </div>
            </div>
          )}

          {/* List */}
          {!suggestionsLoading && !suggestionsError && hasSuggestions && (
            <>
              <div className="space-y-4">
                {appointmentSuggestions.map((suggestion) => (
                  <div
                    key={suggestion.id}
                    className={`border-2 rounded-lg p-4 cursor-pointer transition-all ${
                      selectedSuggestion?.id === suggestion.id
                        ? "border-indigo-600 bg-indigo-50"
                        : "border-gray-200 hover:border-indigo-300 hover:bg-gray-50"
                    }`}
                    onClick={() => onSelect(suggestion)}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <h4 className="font-semibold text-gray-900">
                        {suggestion.title}
                      </h4>
                      {suggestion.recommended && (
                        <span className="px-2 py-1 bg-green-100 text-green-800 text-xs rounded-full">
                          Recommended
                        </span>
                      )}
                    </div>

                    <div className="flex items-center justify-between mb-3">
                      <div className="flex flex-col space-y-1">
                        <span className="text-lg font-bold text-indigo-600">
                          {suggestion.startTime} - {suggestion.endTime}
                        </span>
                        <div className="flex items-center space-x-4">
                          <span className="text-sm text-gray-500">
                            {suggestion.formattedDate}
                          </span>
                          <span className="text-sm text-gray-600">
                            Duration: {suggestion.duration} min
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      {suggestion.timeline.map(
                        (item: any, index: number) => (
                          <div
                            key={index}
                            className="flex items-center space-x-3 text-sm"
                          >
                            <div className="w-2 h-2 bg-indigo-600 rounded-full" />
                            <span className="font-medium text-gray-900">
                              {item.startTime} - {item.endTime}
                            </span>
                            <span className="text-gray-600">
                              {item.service}
                            </span>
                            <span className="text-gray-500">
                              ({item.professional})
                            </span>
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {selectedSuggestion && (
                <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center text-green-700">
                    <CheckCircle className="w-5 h-5 mr-2" />
                    Selected: {selectedSuggestion.title} at{" "}
                    {selectedSuggestion.startTime}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}