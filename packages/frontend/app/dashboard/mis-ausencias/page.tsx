"use client";

import { TimeOffManager } from "@/components/time-off/TimeOffManager";

/**
 * A professional's own time off: what the salon recorded for them and what
 * they asked for, with the answer. What they ask for here is a request: it
 * blocks nothing until the owner or a manager approves it.
 */
export default function MyTimeOffPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Mis ausencias</h1>
        <p className="text-gray-500 mt-1">
          Pide vacaciones, un día libre o unas horas. El responsable del salón la aprueba o la rechaza, y te
          avisamos en las notificaciones. Hasta que se apruebe, tu agenda sigue abierta para nuevas citas.
        </p>
      </div>
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <TimeOffManager professionalId={null} self />
      </div>
    </div>
  );
}
