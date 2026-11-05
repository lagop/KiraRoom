import React from "react";
import {
  CheckCircle,
  Clock,
  Edit,
  Eye,
  Loader2,
  Save,
  UserX,
  XCircle,
} from "lucide-react";
import { AppointmentStatusBadge } from "../primitives/AppointmentStatusBadge";
import { formatDateTimeString, statusActions } from "../../appointment-drawer.utils";
import type { Appointment, AppointmentStatus } from "../types";

/**
 * Header action bar for the appointment detail view.
 *
 * Verbatim move from `appointment-drawer.tsx:1025-1140`. Three
 * concerns, all in one place:
 *
 *   1. **Status pill** + "Created at" timestamp (always visible).
 *   2. **Edit / Save / Cancel** buttons — toggle between view and
 *      edit mode, save triggers `handleUpdate()`.
 *   3. **Status change** buttons — what `statusActions()` offers for
 *      the status (the server's transition table decides): the next
 *      step, "No se presentó", "Cancelar". All hidden while
 *      `updating === true`.
 *
 * The section is **not** in charge of the edit form body itself
 * (Schedule / Service / Add-ons / Recurrence cards). Those stay in
 * the orchestrator for now (Phase 5b-3 was scoped to the action
 * bar; the body extraction is the next thing to tackle).
 */

export interface EditModeActionsProps {
  appointment: Appointment;
  editMode: boolean;
  notesEditMode: boolean;
  updating: boolean;
  onEnterEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onStatusChange: (newStatus: AppointmentStatus) => void;
  labels: {
    created: string;
    viewMode: string;
    saving: string;
    save: string;
    edit: string;
    updating: string;
    confirm: string;
    cancel: string;
    start: string;
    complete: string;
    noShow: string;
  };
}

const STATUS_BUTTONS: Partial<
  Record<
    AppointmentStatus,
    { icon: React.ReactNode; className: string; label: keyof EditModeActionsProps["labels"] }
  >
> = {
  confirmed: { icon: <CheckCircle className="w-3 h-3 mr-1" />, className: "bg-green-600 hover:bg-green-700", label: "confirm" },
  in_progress: { icon: <Clock className="w-3 h-3 mr-1" />, className: "bg-blue-600 hover:bg-blue-700", label: "start" },
  completed: { icon: <CheckCircle className="w-3 h-3 mr-1" />, className: "bg-green-600 hover:bg-green-700", label: "complete" },
  no_show: { icon: <UserX className="w-3 h-3 mr-1" />, className: "bg-gray-600 hover:bg-gray-700", label: "noShow" },
  cancelled: { icon: <XCircle className="w-3 h-3 mr-1" />, className: "bg-red-600 hover:bg-red-700", label: "cancel" },
};

export function EditModeActions({
  appointment,
  editMode,
  updating,
  onEnterEdit,
  onCancelEdit,
  onSave,
  onStatusChange,
  labels,
}: EditModeActionsProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-2 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 sm:gap-x-4">
          <AppointmentStatusBadge status={appointment.status} />
          <div className="text-xs text-gray-500 truncate">
            {labels.created} {formatDateTimeString(appointment.createdAt)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 sm:gap-2">
          {editMode ? (
            <>
              <button
                type="button"
                onClick={onCancelEdit}
                className="inline-flex items-center px-2 py-1 bg-gray-200 text-gray-700 text-xs rounded hover:bg-gray-300 transition-colors"
              >
                <Eye className="w-3 h-3 mr-1" />
                {labels.viewMode}
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={updating}
                className="inline-flex items-center px-2 py-1 bg-indigo-600 text-white text-xs rounded hover:bg-indigo-700 transition-colors disabled:opacity-50"
              >
                {updating ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin mr-1" />
                    {labels.saving}
                  </>
                ) : (
                  <>
                    <Save className="w-3 h-3 mr-1" />
                    {labels.save}
                  </>
                )}
              </button>
            </>
          ) : (
            appointment.status !== "completed" && (
              <button
                type="button"
                onClick={onEnterEdit}
                className="inline-flex items-center px-2 py-1 bg-gray-600 text-white text-xs rounded hover:bg-gray-700 transition-colors"
              >
                <Edit className="w-3 h-3 mr-1" />
                {labels.edit}
              </button>
            )
          )}

          {updating ? (
            <span className="inline-flex items-center px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
              {labels.updating}
            </span>
          ) : (
            <>
              {statusActions(appointment.status).map((to) => {
                const button = STATUS_BUTTONS[to];
                if (!button) return null;
                return (
                  <button
                    key={to}
                    type="button"
                    onClick={() => onStatusChange(to)}
                    className={`inline-flex items-center px-2 py-1 ${button.className} text-white text-xs rounded transition-colors`}
                  >
                    {button.icon}
                    {labels[button.label]}
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
