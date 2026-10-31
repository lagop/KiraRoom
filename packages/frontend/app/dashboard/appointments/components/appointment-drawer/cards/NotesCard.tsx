import React from "react";
import { Edit, Loader2, Save } from "lucide-react";
import type { Appointment } from "../types";

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
  /** Saves the notes alone (notes edit mode; full edit mode saves from the action bar). */
  onSave: () => void;
  saving: boolean;
  labels: {
    notes: string;
    cancel: string;
    save: string;
    saving: string;
    edit: string;
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
  onSave,
  saving,
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
            aria-label={labels.edit}
            title={labels.edit}
          >
            <Edit className="w-4 h-4" />
          </button>
        )}
      </div>
      {inEdit ? (
        <>
          <textarea
            aria-label={labels.notes}
            value={editedNotes}
            onChange={(e) => onNotesChange(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
            rows={4}
          />
          {/* Notes alone (a completed appointment): saved from here, as
              the action bar offers no Save outside edit mode. */}
          {notesEditMode && !editMode && (
            <div className="flex justify-end mt-2">
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="inline-flex items-center px-3 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-1" />
                ) : (
                  <Save className="w-4 h-4 mr-1" />
                )}
                {saving ? labels.saving : labels.save}
              </button>
            </div>
          )}
        </>
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
