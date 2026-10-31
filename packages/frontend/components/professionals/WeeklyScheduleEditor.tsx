"use client";

import React from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MAX_SHIFTS_PER_DAY,
  WEEK_DAYS,
  addShift,
  copyMondayToWeekdays,
  removeShift,
  scheduleProblems,
  toggleDay,
  updateShift,
  type WeeklySchedule,
} from "@/lib/weekly-schedule";

interface WeeklyScheduleEditorProps {
  value: WeeklySchedule;
  onChange: (next: WeeklySchedule) => void;
  disabled?: boolean;
  className?: string;
  /** Whose week it is: only the wording changes. A professional's by default. */
  variant?: "professional" | "salon";
  /** Replaces the whole-week problem (no day on) with the caller's own words. */
  weekProblem?: string | null;
}

const COPY = {
  professional: {
    hint: "Marca los días que trabaja. Si para a comer, añade un segundo tramo.",
    on: "trabaja",
    off: "libre",
    offLabel: "Libre",
  },
  salon: {
    hint: "Marca los días que abre el salón. Si cierra a mediodía, añade un segundo tramo.",
    on: "abierto",
    off: "cerrado",
    offLabel: "Cerrado",
  },
} as const;

/**
 * A week of shifts: per day, whether it is on and in which shifts. A split
 * day (jornada partida, 10:00–14:00 and 17:00–20:00) is two shifts. Used for
 * a professional's schedule and for the salon's own opening hours (settings).
 *
 * Problems are shown next to the day they are on as they happen; the parent
 * runs `hasProblems` from lib/weekly-schedule before saving, and the server
 * refuses the same things again.
 */
export function WeeklyScheduleEditor({
  value,
  onChange,
  disabled,
  className,
  variant = "professional",
  weekProblem,
}: WeeklyScheduleEditorProps) {
  const problems = scheduleProblems(value);
  const copy = COPY[variant];
  const wholeWeekProblem = problems.week && weekProblem !== undefined ? weekProblem : problems.week;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-500">
          {copy.hint}
        </p>
        <button
          type="button"
          onClick={() => onChange(copyMondayToWeekdays(value))}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
          Copiar el lunes de martes a viernes
        </button>
      </div>

      <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
        {WEEK_DAYS.map(({ key, label }) => {
          const day = value[key];
          const problem = problems.days[key];
          const switchId = variant === "salon" ? `salon-open-${key}` : `works-${key}`;
          return (
            <li key={key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
              <div className="flex w-40 shrink-0 items-center gap-3 pt-1">
                <button
                  id={switchId}
                  type="button"
                  role="switch"
                  aria-checked={day.works}
                  aria-label={`${label}: ${day.works ? copy.on : copy.off}`}
                  onClick={() => onChange(toggleDay(value, key))}
                  disabled={disabled}
                  className={cn(
                    "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
                    day.works ? "bg-indigo-600" : "bg-gray-300",
                  )}
                >
                  <span
                    className={cn(
                      "inline-block h-4 w-4 rounded-full bg-white shadow transition-transform",
                      day.works ? "translate-x-4" : "translate-x-0.5",
                    )}
                  />
                </button>
                <label htmlFor={switchId} className="text-sm font-medium text-gray-900">
                  {label}
                </label>
              </div>

              <div className="flex-1 space-y-2">
                {!day.works ? (
                  <p className="pt-1 text-sm text-gray-400">{copy.offLabel}</p>
                ) : (
                  <>
                    {day.shifts.map((shift, index) => (
                      <div key={index} className="flex flex-wrap items-center gap-2">
                        <input
                          type="time"
                          aria-label={`${label}, tramo ${index + 1}: inicio`}
                          value={shift.start}
                          onChange={(e) => onChange(updateShift(value, key, index, { start: e.target.value }))}
                          disabled={disabled}
                          className={cn(
                            "rounded-md border px-2 py-1 text-sm",
                            problem ? "border-red-400" : "border-gray-300",
                          )}
                        />
                        <span className="text-gray-400">–</span>
                        <input
                          type="time"
                          aria-label={`${label}, tramo ${index + 1}: fin`}
                          value={shift.end}
                          onChange={(e) => onChange(updateShift(value, key, index, { end: e.target.value }))}
                          disabled={disabled}
                          className={cn(
                            "rounded-md border px-2 py-1 text-sm",
                            problem ? "border-red-400" : "border-gray-300",
                          )}
                        />
                        <button
                          type="button"
                          onClick={() => onChange(removeShift(value, key, index))}
                          disabled={disabled}
                          aria-label={`Quitar el tramo ${index + 1} del ${label.toLowerCase()}`}
                          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600 disabled:opacity-50"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                    {day.shifts.length < MAX_SHIFTS_PER_DAY && (
                      <button
                        type="button"
                        onClick={() => onChange(addShift(value, key))}
                        disabled={disabled}
                        className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-800 disabled:opacity-50"
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        Añadir tramo
                      </button>
                    )}
                    {problem && (
                      <p role="alert" className="text-sm text-red-600">
                        {problem}
                      </p>
                    )}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {wholeWeekProblem && (
        <p role="alert" className="text-sm text-red-600">
          {wholeWeekProblem}
        </p>
      )}
    </div>
  );
}
