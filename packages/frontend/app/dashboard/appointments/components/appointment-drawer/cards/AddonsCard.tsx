import React from "react";
import { Clock, DollarSign, Scissors, X } from "lucide-react";
import type { CatalogService } from "../hooks/useAppointmentCatalog";
import type { Appointment } from "../types";

/**
 * Add-ons card on the appointment detail view.
 *
 * Verbatim move from `appointment-drawer.tsx:1249-1330 (single-mode
 * "Add-ons" subsection) + 1521-1562 (view-mode "Add-ons" list)`.
 *
 * Two paths:
 *
 *   - **Edit mode (single-service only)**: a select to pick an
 *     existing service as an add-on, a quantity input, an Add button.
 *   - **View mode**: a list of the appointment's `addons` (read-only).
 *
 * The multi-service "Add Services" flow is in `ServiceCard`, not here,
 * because that flow mutates `appointment.services` (more services)
 * whereas this card mutates `currentAddons` (add-ons). They share
 * the same `selectedAddon` state but not the same destination.
 *
 * Local-only state in the orchestrator: `selectedAddon` and
 * `addonQuantity`. The card receives both values and their setters.
 */

export interface AddonsCardProps {
  appointment: Appointment;
  editMode: boolean;
  currentAddons: ReadonlyArray<{
    id: string;
    name: string;
    quantity: number;
    price: number;
    duration: number;
  }>;
  services: ReadonlyArray<CatalogService>;
  selectedAddon: string;
  addonQuantity: number;
  editedServiceId?: string;
  onSelectedAddonChange: (serviceId: string) => void;
  onAddonQuantityChange: (qty: number) => void;
  onAddAddon: () => void;
  onRemoveAddon: (index: number) => void;
  labels: {
    addOns: string;
    selectAddOn: string;
    add: string;
    quantity: string;
  };
}

export function AddonsCard({
  appointment,
  editMode,
  currentAddons,
  services,
  selectedAddon,
  addonQuantity,
  editedServiceId,
  onSelectedAddonChange,
  onAddonQuantityChange,
  onAddAddon,
  onRemoveAddon,
  labels,
}: AddonsCardProps) {
  return (
    <div className="mt-4">
      {/* Edit mode (single-service only) */}
      {editMode &&
        (!appointment.services || appointment.services.length === 0) && (
          <>
            <h3 className="text-sm font-medium text-gray-900">
              {labels.addOns}
            </h3>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-2">
              <select
                value={selectedAddon}
                onChange={(e) => onSelectedAddonChange(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-sm w-full sm:flex-1 min-w-0"
              >
                <option value="">{labels.selectAddOn}</option>
                {services
                  .filter(
                    (s) => String(s.id) !== String(editedServiceId),
                  )
                  .map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name} - ${service.price}
                    </option>
                  ))}
              </select>
              <input
                type="number"
                min="1"
                value={addonQuantity}
                onChange={(e) =>
                  onAddonQuantityChange(Number(e.target.value))
                }
                className="border border-gray-300 rounded px-2 py-1 text-sm w-full sm:w-16"
              />
              <button
                type="button"
                onClick={onAddAddon}
                className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
              >
                {labels.add}
              </button>
            </div>
            <div className="mt-2 space-y-1">
              {currentAddons.map((addon, index) => (
                <div
                  key={addon.id}
                  className="flex items-center justify-between gap-2 bg-gray-50 p-2 rounded"
                >
                  <span className="text-sm truncate">
                    {addon.name} - ${(Number(addon.price) || 0).toFixed(2)} x
                    {addon.quantity}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveAddon(index)}
                    className="text-red-600 hover:text-red-800 flex-shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

      {/* View mode (multi-service or single-service) */}
      {!editMode &&
        appointment.addons &&
        appointment.addons.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-gray-900 mb-2">
              {labels.addOns}
            </h3>
            <div className="space-y-2">
              {appointment.addons.map((addon) => (
                <div
                  key={addon.id}
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-gray-50 p-3 rounded-lg"
                >
                  <div className="flex items-center space-x-3 min-w-0">
                    <div className="p-2 bg-blue-50 rounded-lg flex-shrink-0">
                      <Scissors className="w-4 h-4 text-blue-600" />
                    </div>
                    <div className="min-w-0">
                      <h4 className="font-medium text-gray-900 truncate">
                        {addon.name}
                      </h4>
                      <p className="text-sm text-gray-500">
                        {labels.quantity}: {addon.quantity}
                      </p>
                    </div>
                  </div>
                  <div className="text-left sm:text-right">
                    <span className="text-sm font-medium text-gray-900">
                      <DollarSign className="w-4 h-4 inline mr-1" />
                      ${(Number(addon.price) || 0).toFixed(2)}
                    </span>
                    <div className="text-xs text-gray-500 mt-1">
                      <Clock className="w-3 h-3 inline mr-1" />
                      {addon.duration} min
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
    </div>
  );
}
