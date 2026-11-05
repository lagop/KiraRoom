"use client";

import React from "react";
import { WeeklyScheduleEditor } from "@/components/professionals/WeeklyScheduleEditor";
import { SALON_WEEK_EMPTY, type SalonHoursSetting } from "@/lib/salon-hours";

interface SalonHoursFieldProps {
  value: SalonHoursSetting;
  onChange: (next: SalonHoursSetting) => void;
  disabled?: boolean;
}

/**
 * "Horario del salón" in settings: the salon's own week, with shifts, or no
 * salon-level hours at all (each professional's schedule decides, as before
 * this existed). The choice is explicit because an empty week cannot mean
 * both "closed every day" and "no limit": it is stored as the latter.
 */
export function SalonHoursField({ value, onChange, disabled }: SalonHoursFieldProps) {
  const option = (limited: boolean, title: string, detail: string) => (
    <label
      className={`flex flex-1 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${
        value.limited === limited ? "border-purple-500 bg-purple-50" : "border-gray-200"
      } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <input
        type="radio"
        name="salon-hours-mode"
        checked={value.limited === limited}
        onChange={() => onChange({ ...value, limited })}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 text-purple-600 focus:ring-purple-500"
      />
      <span>
        <span className="block font-medium text-gray-900">{title}</span>
        <span className="block text-gray-500">{detail}</span>
      </span>
    </label>
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        {option(
          true,
          "Horario propio del salón",
          "Nadie puede reservar fuera de él, aunque un profesional tenga turno. Los días sin horario el salón está cerrado.",
        )}
        {option(
          false,
          "Sin horario del salón",
          "Se usa el horario de cada profesional, sin límite a nivel de salón.",
        )}
      </div>
      {value.limited && (
        <WeeklyScheduleEditor
          variant="salon"
          value={value.week}
          onChange={(week) => onChange({ ...value, week })}
          disabled={disabled}
          weekProblem={SALON_WEEK_EMPTY}
        />
      )}
      {value.limited && (
        <p className="text-xs text-gray-500">
          Las reservas online, la recepcionista virtual y tu página pública respetan este horario. Desde el
          calendario puedes seguir dando una cita fuera de él: te pediremos confirmarlo.
        </p>
      )}
    </div>
  );
}
