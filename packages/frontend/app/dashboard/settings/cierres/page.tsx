"use client";

import { TimeOffManager } from "@/components/time-off/TimeOffManager";

/**
 * Days or hours the whole salon is closed: bank holidays, local festivities,
 * a refit. Nobody can be booked online or by the receptionist then, and the
 * calendar shades them; what was already booked stays, and the salon is
 * shown which appointments clash before saving.
 */
export default function ClosuresPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Cierres y festivos</h1>
        <p className="text-gray-500 mt-1">
          Los días en que el salón no abre. No se ofrecen citas online ni por la recepcionista, y la página de
          reservas los muestra como cerrados.
        </p>
      </div>
      <div className="rounded-xl border border-gray-200 bg-white p-6">
        <TimeOffManager professionalId={null} />
      </div>
    </div>
  );
}
