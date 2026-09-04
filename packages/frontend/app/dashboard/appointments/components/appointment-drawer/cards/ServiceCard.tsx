import React from "react";
import { Clock, Edit, Scissors, User, X } from "lucide-react";
import type { CatalogProfessional, CatalogService } from "../hooks/useAppointmentCatalog";
import type { Appointment } from "../types";

/**
 * Services card on the appointment detail view.
 *
 * Verbatim move from `appointment-drawer.tsx:1085-1248 + 1432-1520`. Three
 * sub-paths:
 *
 *   - **Multi-service display** (edit mode): a list of service cards
 *     with name, price, duration, "Parallel" badge, and a per-service
 *     professional selector + remove button.
 *   - **Single-service edit** (edit mode, no `appointment.services`):
 *     a `<select>` of all services.
 *   - **View mode (multi-service)**: a list of service cards (read-only
 *     except for the per-service professional display).
 *   - **View mode (single-service)**: a single service card.
 *
 * Local-only state in the orchestrator: `selectedAddon` (for the
 * "Add Services" select). The card receives the current value +
 * setter; it does not own the value.
 */

export interface ServiceCardProps {
  appointment: Appointment;
  editedAppointment: Partial<Appointment> | null;
  editMode: boolean;
  services: ReadonlyArray<CatalogService>;
  professionals: ReadonlyArray<CatalogProfessional>;
  selectedAddon: string;
  onEnterEditMode: () => void;
  onServiceChange: (serviceId: string) => void;
  onRemoveService: (index: number) => void;
  onUpdateProfessional: (index: number, professionalId: string) => void;
  onSelectedAddonChange: (serviceId: string) => void;
  onAddService: () => void;
  labels: {
    services: string;
    parallel: string;
    selectProfessional: string;
    addMoreServices: string;
    selectServiceToAdd: string;
    add: string;
  };
}

export function ServiceCard({
  appointment,
  editedAppointment,
  editMode,
  services,
  professionals,
  selectedAddon,
  onEnterEditMode,
  onServiceChange,
  onRemoveService,
  onUpdateProfessional,
  onSelectedAddonChange,
  onAddService,
  labels,
}: ServiceCardProps) {
  const isMulti = !!(
    appointment.services && appointment.services.length > 0
  );
  const renderMultiEdit = editMode && isMulti;
  const renderSingleEdit = editMode && !isMulti;
  const renderMultiView = !editMode && isMulti;
  const renderSingleView = !editMode && !isMulti;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-lg font-semibold text-gray-900">
          {labels.services}
        </h2>
        {!editMode && appointment.status !== "completed" && (
          <button
            onClick={onEnterEditMode}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            aria-label="Editar servicios"
          >
            <Edit className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Multi-service display in edit mode */}
      {renderMultiEdit && (
        <div className="space-y-4">
          {appointment.services!.map((appService, index) => {
            const serviceProfessionals = professionals.filter((prof) =>
              prof.services?.some(
                (ps) => ps.serviceId === appService.service?.id,
              ),
            );
            return (
              <div
                key={appService.id || index}
                className="flex flex-col sm:flex-row sm:items-start sm:space-x-4 p-4 bg-purple-50 rounded-lg space-y-3 sm:space-y-0"
              >
                <div className="p-3 bg-purple-100 rounded-lg self-start flex-shrink-0">
                  <Scissors className="w-6 h-6 text-purple-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-gray-900 truncate">
                      {appService.service?.name || "Service"}
                    </h3>
                    <button
                      type="button"
                      onClick={() => onRemoveService(index)}
                      className="text-red-600 hover:text-red-800 p-1 flex-shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    {appService.service?.description || ""}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3">
                    <span className="text-sm text-gray-600">
                      <Clock className="w-4 h-4 inline mr-1" />
                      {appService.service?.duration || 0} min
                    </span>
                    <span className="text-sm font-medium text-gray-900">
                      $
                      {(
                        Number(appService.service?.price) || 0
                      ).toFixed(2)}
                    </span>
                    {appService.isParallel && (
                      <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">
                        {labels.parallel}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 pt-3 border-t border-purple-200">
                    <div className="flex items-center space-x-2">
                      <User className="w-4 h-4 text-purple-600 flex-shrink-0" />
                      <select
                        value={appService.professional?.id || ""}
                        onChange={(e) =>
                          onUpdateProfessional(index, e.target.value)
                        }
                        className="border border-gray-300 rounded px-2 py-1 text-sm flex-1 min-w-0"
                      >
                        <option value="">{labels.selectProfessional}</option>
                        {serviceProfessionals.map((prof) => (
                          <option key={prof.id} value={prof.id}>
                            {prof.firstName} {prof.lastName}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Single-service edit mode */}
      {renderSingleEdit && (
        <div className="flex items-center space-x-2 mb-4">
          <select
            value={
              editedAppointment?.service?.id || appointment.service.id
            }
            onChange={(e) => onServiceChange(e.target.value)}
            className="border border-gray-300 rounded px-2 py-1 text-sm flex-1 min-w-0"
          >
            {services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* View mode multi-service */}
      {renderMultiView && (
        <div className="space-y-4">
          {appointment.services!.map((appService, index) => (
            <div
              key={appService.id || index}
              className="flex flex-col sm:flex-row sm:items-start sm:space-x-4 p-4 bg-purple-50 rounded-lg space-y-3 sm:space-y-0"
            >
              <div className="p-3 bg-purple-100 rounded-lg self-start flex-shrink-0">
                <Scissors className="w-6 h-6 text-purple-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-gray-900 truncate">
                  {appService.service?.name || "Service"}
                </h3>
                <p className="text-sm text-gray-500 mt-1">
                  {appService.service?.description || ""}
                </p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3">
                  <span className="text-sm text-gray-600">
                    <Clock className="w-4 h-4 inline mr-1" />
                    {appService.service?.duration || 0} min
                  </span>
                  <span className="text-sm font-medium text-gray-900">
                    $
                    {(
                      Number(appService.service?.price) || 0
                    ).toFixed(2)}
                  </span>
                  {appService.isParallel && (
                    <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">
                      {labels.parallel}
                    </span>
                  )}
                </div>
                {appService.professional && (
                  <div className="mt-3 pt-3 border-t border-purple-200">
                    <div className="flex items-center space-x-2">
                      <User className="w-4 h-4 text-purple-600 flex-shrink-0" />
                      <span className="text-sm font-medium text-gray-900 truncate">
                        {appService.professional.firstName}{" "}
                        {appService.professional.lastName}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* View mode single-service */}
      {renderSingleView && (
        <div className="flex flex-col sm:flex-row sm:items-start sm:space-x-4 space-y-3 sm:space-y-0">
          <div className="p-3 bg-purple-50 rounded-lg self-start flex-shrink-0">
            <Scissors className="w-6 h-6 text-purple-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-gray-900 truncate">
              {editMode && editedAppointment?.service?.name
                ? editedAppointment.service.name
                : appointment.service.name}
            </h3>
            <p className="text-sm text-gray-500 mt-1">
              {appointment.service.description}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3">
              <span className="text-sm text-gray-600">
                <Clock className="w-4 h-4 inline mr-1" />
                {appointment.service.duration} min
              </span>
              <span className="text-sm font-medium text-gray-900">
                $
                {(
                  Number(
                    editMode &&
                      editedAppointment?.service?.price !== undefined
                      ? editedAppointment.service.price
                      : appointment.service.price,
                  ) || 0
                ).toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* "Add Services" — only in multi-service edit mode */}
      {editMode && isMulti && (
        <div className="mt-4">
          <h3 className="text-sm font-medium text-gray-900">
            {labels.addMoreServices}
          </h3>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-2">
            <select
              value={selectedAddon}
              onChange={(e) => onSelectedAddonChange(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm w-full sm:flex-1 min-w-0"
            >
              <option value="">{labels.selectServiceToAdd}</option>
              {services
                .filter(
                  (s) =>
                    !appointment.services?.some(
                      (aps) => String(aps.service?.id) === String(s.id),
                    ),
                )
                .map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name} - ${service.price} ({service.duration} min)
                  </option>
                ))}
            </select>
            <button
              type="button"
              onClick={onAddService}
              disabled={!selectedAddon}
              className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {labels.add}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
