"use client";

import { useState } from "react";
import type { ServiceOnlyEffect } from "./drag-move";
import { serviceOnlyText } from "./drag-move";

export type MoveScope = "visit" | "service";

interface MoveVisitDialogProps {
  /** "Ana" — whose service was dragged. */
  professionalName: string;
  /** "Corte" — the dragged service. */
  serviceName?: string;
  /** "a las 11:00". */
  when: string;
  /** What moving only this service would do to the client. */
  serviceOnly: ServiceOnlyEffect;
  onConfirm: (scope: MoveScope) => void;
  onCancel: () => void;
}

/**
 * Shown to owners and managers when they drop one service of a multi-service
 * visit: move the whole visit (default: the client keeps the same flow) or
 * only this service (a wait agreed with her), with its effect spelled out.
 */
export function MoveVisitDialog({ professionalName, serviceName, when, serviceOnly, onConfirm, onCancel }: MoveVisitDialogProps) {
  const [scope, setScope] = useState<MoveScope>("visit");
  const serviceOnlyBlocked = serviceOnly.kind === "two-places";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" role="dialog" aria-modal="true" aria-labelledby="move-visit-title">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-4">
        <h2 id="move-visit-title" className="text-lg font-semibold text-gray-900">
          Mover la cita {when}
        </h2>
        <p className="text-sm text-gray-600">Esta visita tiene varios servicios. ¿Qué quieres mover?</p>

        <label className="flex gap-3 p-3 border rounded-lg cursor-pointer has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50">
          <input type="radio" name="move-scope" checked={scope === "visit"} onChange={() => setScope("visit")} className="mt-1" />
          <span>
            <span className="block font-medium text-gray-900">Toda la visita</span>
            <span className="block text-sm text-gray-600">
              Todos los servicios se mueven lo mismo, en el mismo orden. La clienta no espera más que antes.
            </span>
          </span>
        </label>

        <label
          className={`flex gap-3 p-3 border rounded-lg ${serviceOnlyBlocked ? "opacity-60 cursor-not-allowed" : "cursor-pointer"} has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50`}
        >
          <input
            type="radio"
            name="move-scope"
            checked={scope === "service"}
            disabled={serviceOnlyBlocked}
            onChange={() => setScope("service")}
            className="mt-1"
          />
          <span>
            <span className="block font-medium text-gray-900">
              Solo {serviceName ? `el ${serviceName.toLowerCase()} ` : "el servicio "}de {professionalName}
            </span>
            <span className={`block text-sm ${serviceOnly.kind === "wait" || serviceOnlyBlocked ? "text-amber-700" : "text-gray-600"}`}>
              {serviceOnlyText(serviceOnly)}
            </span>
          </span>
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 border rounded-lg hover:bg-gray-50" onClick={onCancel}>
            Cancelar
          </button>
          <button
            type="button"
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            onClick={() => onConfirm(scope)}
          >
            Mover
          </button>
        </div>
      </div>
    </div>
  );
}
