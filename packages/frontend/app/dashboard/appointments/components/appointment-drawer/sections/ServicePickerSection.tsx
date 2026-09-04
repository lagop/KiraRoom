import React from "react";
import { Scissors } from "lucide-react";
import type { CatalogProfessional, CatalogService } from "../hooks/useAppointmentCatalog";
import type { SelectedService } from "../hooks/useAppointmentFormState";
import type { CatalogUser } from "../hooks/useAppointmentCatalog";

/**
 * Step 2 of the create-mode form: service (multi-)selection.
 *
 * Verbatim move from `appointment-drawer.tsx:674-928`. Two paths:
 *
 *   1. **Multi-select cards grid** (when `selectedServices.length > 0`)
 *      Each card is a service. Click toggles selection. When selected,
 *      a per-service block appears below the price/duration showing
 *      the assigned professional (or "Auto-assign") and a "run in
 *      parallel" checkbox.
 *
 *   2. **Single-select dropdown** (when no service is selected yet)
 *      A simple <select> of all services. When a service is picked,
 *      a separate professional selector appears below it.
 *
 * The section is **state-driven** — the parent owns `selectedServices`
 * and `newAppointment`; the section just renders the UI and reports
 * user actions via `onToggle` and the `onSelectedServicesChange` /
 * `onNewAppointmentChange` callbacks (mirroring the setters).
 */

export interface ServicePickerSectionProps {
  services: ReadonlyArray<CatalogService>;
  professionals: ReadonlyArray<CatalogProfessional>;
  selectedServices: SelectedService[];
  newAppointment: { serviceId: string; professionalId: string };
  currentUser: CatalogUser | null;
  allowProfessionalCrossBooking: boolean;
  /**
   * Called when the user toggles a service card in the multi-select
   * grid. Receives the serviceId, the suggested professionalId
   * (always set for staff users, undefined otherwise), and the
   * isParallel flag (defaults to false).
   */
  onToggle: (
    serviceId: string,
    professionalId?: string,
    isParallel?: boolean,
  ) => void;
  /**
   * Called when the user picks a professional from the per-service
   * dropdown (multi-select path) or from the single-service path.
   */
  onServiceProfessionalChange: (serviceId: string, professionalId: string) => void;
  /**
   * Called when the user toggles the "run in parallel" checkbox.
   */
  onParallelChange: (serviceId: string, isParallel: boolean) => void;
  /**
   * Called when the user picks a service from the fallback dropdown
   * (single-select path).
   */
  onSingleServiceChange: (serviceId: string) => void;
  /**
   * Called when the user picks a professional from the
   * single-service professional dropdown.
   */
  onSingleProfessionalChange: (professionalId: string) => void;
  /**
   * Total price across selectedServices (or fallback service). Passed
   * in by the orchestrator so the helper lives next to other pricing
   * helpers in `appointment-drawer.utils.ts`.
   */
  totalPrice: number;
  /**
   * Total duration across selectedServices (or fallback service).
   */
  totalDuration: number;
  /**
   * Localized strings. The orchestrator passes the live `t()` value
   * from `useTranslations()`.
   */
  labels: {
    services: string;
    selected: string;
    professional: string;
    autoAssign: string;
    runInParallel: string;
    selectAService: string;
    selectAProfessional: string;
    totalPrice: string;
    totalDuration: string;
    assignedTo: (name: string) => string;
  };
}

export function ServicePickerSection({
  services,
  professionals,
  selectedServices,
  newAppointment,
  currentUser,
  allowProfessionalCrossBooking,
  onToggle,
  onServiceProfessionalChange,
  onParallelChange,
  onSingleServiceChange,
  onSingleProfessionalChange,
  totalPrice,
  totalDuration,
  labels,
}: ServicePickerSectionProps) {
  const inMultiMode = selectedServices.length > 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
        <Scissors className="w-5 h-5 mr-2 text-indigo-600" />
        {labels.services}{" "}
        {inMultiMode && (
          <span className="ml-2 text-sm font-normal text-indigo-600">
            ({selectedServices.length} {labels.selected})
          </span>
        )}
      </h3>

      {inMultiMode ? (
        <>
          {/* Multi-select cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
            {services.map((service) => {
              const isSelected = selectedServices.some(
                (s) => s.serviceId === service.id,
              );
              const selection = selectedServices.find(
                (s) => s.serviceId === service.id,
              );

              const serviceProfessionals = professionals.filter((pro) =>
                pro.services?.some((ps) => ps.serviceId === service.id),
              );

              // For staff users, always pre-bind to themselves (unless
              // cross-booking is enabled). Otherwise leave it undefined
              // so the suggestion engine can auto-assign.
              const suggestedProfessionalId =
                currentUser?.role === "staff"
                  ? currentUser.professionalId
                  : undefined;

              return (
                <div
                  key={service.id}
                  className={`relative p-4 rounded-xl border-2 transition-all ${
                    isSelected
                      ? "border-indigo-600 bg-indigo-50"
                      : "border-gray-200 hover:border-indigo-300 hover:shadow-sm"
                  }`}
                >
                  {/* Card header with selection */}
                  <div className="flex items-start justify-between mb-3">
                    <div
                      className="flex-1 cursor-pointer"
                      onClick={() =>
                        onToggle(service.id, suggestedProfessionalId)
                      }
                    >
                      <p className="font-semibold text-gray-900">
                        {service.name}
                      </p>
                      <p className="text-lg font-bold text-indigo-600 mt-1">
                        €{service.price}
                      </p>
                      <p className="text-sm text-gray-500 mt-1">
                        {service.duration} min
                      </p>
                    </div>

                    {/* Selection checkbox */}
                    <div
                      className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors cursor-pointer ${
                        isSelected
                          ? "bg-indigo-600 border-indigo-600"
                          : "border-gray-300 hover:border-indigo-400"
                      }`}
                      onClick={() =>
                        onToggle(service.id, suggestedProfessionalId)
                      }
                    >
                      {isSelected && (
                        <svg
                          className="w-4 h-4 text-white"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                      )}
                    </div>
                  </div>

                  {/* Professional selector + parallel option (shown only when selected) */}
                  {isSelected && (
                    <div className="mt-3 pt-3 border-t border-indigo-200 space-y-3">
                      {/* Professional selector — only shown for owners/admins or when cross-booking is enabled */}
                      {currentUser?.role !== "staff" && (
                        <div>
                          <label className="text-xs font-medium text-gray-500 block mb-1">
                            {labels.professional}
                          </label>
                          <select
                            value={selection?.professionalId || ""}
                            onChange={(e) =>
                              onServiceProfessionalChange(
                                service.id,
                                e.target.value,
                              )
                            }
                            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
                          >
                            <option value="">{labels.autoAssign}</option>
                            {serviceProfessionals.map((pro) => (
                              <option key={pro.id} value={pro.id}>
                                {pro.firstName} {pro.lastName}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      {/* For staff users, show assignment indicator */}
                      {currentUser?.role === "staff" && isSelected && (
                        <div className="text-xs text-gray-500 bg-gray-50 px-2 py-1 rounded">
                          {labels.assignedTo(
                            `${currentUser.firstName} ${currentUser.lastName}`,
                          )}
                        </div>
                      )}

                      {/* Parallel option */}
                      <label className="flex items-center text-sm text-gray-600 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selection?.isParallel || false}
                          onChange={(e) =>
                            onParallelChange(service.id, e.target.checked)
                          }
                          className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 mr-2"
                        />
                        <span className="text-xs">{labels.runInParallel}</span>
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Total */}
          <div className="mt-4 p-3 bg-indigo-50 rounded-lg">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">{labels.totalPrice}</span>
              <span className="font-semibold text-indigo-700">
                €{totalPrice}
              </span>
            </div>
            <div className="flex justify-between text-sm mt-1">
              <span className="text-gray-600">{labels.totalDuration}</span>
              <span className="font-semibold text-indigo-700">
                {totalDuration} min
              </span>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Hint: services can be added one at a time; once the first is
              picked the section switches to the multi-select cards view
              where additional services can be toggled. */}
          <p className="text-sm text-gray-500 mb-3">
            {labels.selectAService}{" "}
            <span className="text-gray-400">
              · Pick one to continue. You can add more services after.
            </span>
          </p>

          {/* Single-select dropdown */}
          <select
            value={newAppointment.serviceId}
            onChange={(e) => onSingleServiceChange(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
          >
            <option value="">{labels.selectAService}</option>
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name} - €{service.price} ({service.duration} min)
              </option>
            ))}
          </select>

          {/* Single-service professional selector */}
          {newAppointment.serviceId && (
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {labels.professional}
              </label>
              <select
                value={newAppointment.professionalId}
                onChange={(e) => onSingleProfessionalChange(e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
              >
                <option value="">{labels.selectAProfessional}</option>
                {professionals
                  .filter((pro) =>
                    pro.services?.some(
                      (ps) => ps.serviceId === newAppointment.serviceId,
                    ),
                  )
                  .map((professional) => (
                    <option
                      key={professional.id}
                      value={professional.id}
                    >
                      {professional.firstName} {professional.lastName}
                    </option>
                  ))}
              </select>
            </div>
          )}
        </>
      )}
    </div>
  );
}