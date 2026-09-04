import React from "react";
import { Edit } from "lucide-react";
import type { Appointment, AppointmentStatus } from "../types";

/**
 * Notes card on the appointment detail view.
 *
 * Verbatim move from `appointment-drawer.tsx:2036-2097`. Special
 * behavior: when the appointment is `completed`, the notes card
 * exposes a separate "edit notes" toggle (`notesEditMode`) so the
 * user can update notes without re-opening the full edit form.
 *
 * The section owns no internal state — `notesEditMode` and the
 * `editedAppointment` are both orchestrator state, surfaced as props
 * for clarity. The card is read-only when neither `editMode` nor
 * `notesEditMode` is set.
 */

export interface NotesCardProps {
  appointment: Appointment;
  editMode: boolean;
  notesEditMode: boolean;
  editedNotes: string;
  onEnterEditMode: () => void;
  onCancelEdit: () => void;
  onNotesChange: (notes: string) => void;
  labels: {
    notes: string;
    cancel: string;
    noNotesForAppointment: string;
  };
}

export function NotesCard({
  appointment,
  editMode,
  notesEditMode,
  editedNotes,
  onEnterEditMode,
  onCancelEdit,
  onNotesChange,
  labels,
}: NotesCardProps) {
  const inEdit = editMode || notesEditMode;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-lg font-semibold text-gray-900">{labels.notes}</h2>
        {inEdit ? (
          <button
            onClick={onCancelEdit}
            className="text-sm text-gray-500 hover:text-gray-700 flex-shrink-0"
          >
            {labels.cancel}
          </button>
        ) : (
          <button
            onClick={onEnterEditMode}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            aria-label="Editar notas"
          >
            <Edit className="w-4 h-4" />
          </button>
        )}
      </div>
      {inEdit ? (
        <textarea
          value={editedNotes}
          onChange={(e) => onNotesChange(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          rows={4}
        />
      ) : appointment.notes ? (
        <p className="text-sm text-gray-600">{appointment.notes}</p>
      ) : (
        <p className="text-sm text-gray-400 italic">
          {labels.noNotesForAppointment}
        </p>
      )}
    </div>
  );
}
