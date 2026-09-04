import React, { useState } from "react";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import { formatDateTimeString } from "../../appointment-drawer.utils";
import type { Appointment } from "../types";

/**
 * Activity timeline for the appointment view (collapsed by default,
 * expands to show every action entry).
 *
 * Verbatim move from `appointment-drawer.tsx:3006-3065`. The local
 * `activityExpanded` state + `handleActivityToggle` belong to this
 * section now (they were inlined in the orchestrator and referenced
 * here via the `handleActivityToggle` callback). The data fetch
 * itself stays in `useAppointmentData.refreshActivity`.
 */
export interface ActivitySectionProps {
  appointment: Appointment;
  activityLoading: boolean;
  onToggle: () => Promise<void>;
}

export function ActivitySection({
  appointment,
  activityLoading,
  onToggle,
}: ActivitySectionProps) {
  const t = useTranslations();
  // The collapsed/expanded flag is local UI state — only this section
  // cares whether the user has clicked the chevron yet.
  const [expanded, setExpanded] = useState(false);

  const handleToggle = async () => {
    const willExpand = !expanded;
    setExpanded(willExpand);
    // Trigger the backend fetch only on first expand (matches the
    // legacy behaviour where expand-only-not-collapse triggered a
    // refetch). After that, the cached `appointment.activity` is shown.
    if (willExpand) {
      await onToggle();
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-lg font-semibold text-gray-900">
          {t("appointments.activity")}
        </h2>
        <button
          onClick={handleToggle}
          disabled={activityLoading}
          className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
        >
          {activityLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : expanded ? (
            <ChevronUp className="w-4 h-4" />
          ) : (
            <ChevronDown className="w-4 h-4" />
          )}
        </button>
      </div>
      {expanded ? (
        <div className="space-y-4">
          {appointment.activity && appointment.activity.length > 0 ? (
            appointment.activity.map((activity, index) => (
              <div key={index} className="flex items-start space-x-3">
                <div className="w-2 h-2 bg-gray-300 rounded-full mt-2" />
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {activity.action}
                  </p>
                  <p className="text-xs text-gray-500">
                    {formatDateTimeString(activity.timestamp)}
                  </p>
                </div>
              </div>
            ))
          ) : (
            <div className="flex items-start space-x-3">
              <div className="w-2 h-2 bg-green-500 rounded-full mt-2" />
              <div>
                <p className="text-sm font-medium text-gray-900">
                  Appointment {appointment.status}
                </p>
                <p className="text-xs text-gray-500">
                  {formatDateTimeString(appointment.updatedAt)}
                </p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-sm text-gray-500">
          {t("appointments.activity_details_hidden")}
        </div>
      )}
    </div>
  );
}