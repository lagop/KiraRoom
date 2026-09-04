import React from "react";
import { Calendar, Clock, Edit } from "lucide-react";
import {
  calculateTotalDuration,
  formatDateString,
} from "../../appointment-drawer.utils";
import type { Appointment } from "../types";

/**
 * Date & Time card on the appointment detail view.
 *
 * Verbatim move from `appointment-drawer.tsx:1057-1135`. Two-column
 * grid: Date cell, Time cell. Each cell shows an `<input type="date">`
 * or `<input type="time">` in edit mode and a formatted `<p>` in
 * view mode. The edit-mode trigger button is rendered in the card
 * header (replaces the per-card "Edit" icon previously scattered
 * across multiple cards).
 *
 * The card owns no state. `editMode` is the orchestrator-level flag;
 * `editedAppointment` is the orchestrator's mutable form object.
 */

export interface ScheduleCardProps {
  appointment: Appointment;
  editMode: boolean;
  editedDate: string;
  editedTime: string;
  onEnterEditMode: () => void;
  onDateChange: (date: string) => void;
  onTimeChange: (time: string) => void;
  labels: {
    schedule: string;
    date: string;
    time: string;
  };
}

export function ScheduleCard({
  appointment,
  editMode,
  editedDate,
  editedTime,
  onEnterEditMode,
  onDateChange,
  onTimeChange,
  labels,
}: ScheduleCardProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-lg font-semibold text-gray-900">
          {labels.schedule}
        </h2>
        {!editMode && appointment.status !== "completed" && (
          <button
            onClick={onEnterEditMode}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            aria-label="Editar fecha y hora"
          >
            <Edit className="w-4 h-4" />
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        <div className="flex items-start space-x-3">
          <div className="p-2 bg-indigo-50 rounded-lg flex-shrink-0">
            <Calendar className="w-5 h-5 text-indigo-600" />
          </div>
          <div className="min-w-0">
            <p className="text-sm text-gray-500">{labels.date}</p>
            {editMode ? (
              <input
                type="date"
                value={editedDate}
                onChange={(e) => onDateChange(e.target.value)}
                className="font-medium text-gray-900 border border-gray-300 rounded px-2 py-1 w-full"
              />
            ) : (
              <p className="font-medium text-gray-900 truncate">
                {formatDateString(appointment.date)}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-start space-x-3">
          <div className="p-2 bg-indigo-50 rounded-lg flex-shrink-0">
            <Clock className="w-5 h-5 text-indigo-600" />
          </div>
          <div className="min-w-0">
            <p className="text-sm text-gray-500">{labels.time}</p>
            {editMode ? (
              <input
                type="time"
                value={editedTime}
                onChange={(e) => onTimeChange(e.target.value)}
                className="font-medium text-gray-900 border border-gray-300 rounded px-2 py-1 w-full"
              />
            ) : (
              <p className="font-medium text-gray-900 truncate">{appointment.time}</p>
            )}
            <p className="text-sm text-gray-500">
              {calculateTotalDuration(appointment)} minutes
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
