"use client";

import React from "react";
import Link from "next/link";
import { AlertCircle, Clock, User } from "lucide-react";
import { formatDay } from "@/lib/analytics-format";
import { AGENDA_FOCUS_HREF, personName } from "@/lib/home-dashboard";
import { useTranslations } from "@/lib/use-translation";
import type { HomeAppointmentRow } from "./use-dashboard-data";

interface PendingConfirmationsWidgetProps {
  /** The first few, soonest first. */
  appointments: HomeAppointmentRow[];
  /** How many there are in all (the server's count). */
  total: number;
  className?: string;
}

/**
 * The appointments still to confirm, from today on: the soonest ones and how
 * many there are. It showed the five oldest of the last year (visits never
 * closed) and a count that stopped at 5.
 */
export const PendingConfirmationsWidget: React.FC<PendingConfirmationsWidgetProps> = ({
  appointments,
  total,
  className = "",
}) => {
  const t = useTranslations();
  return (
    <div className={`bg-white rounded-xl border border-gray-200 p-6 ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-amber-50 rounded-lg">
            <AlertCircle className="w-4 h-4 text-amber-600" aria-hidden />
          </div>
          <h2 className="text-base font-semibold text-gray-900">{t("dashboard.to_confirm_title")}</h2>
        </div>
        <span
          className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
            total > 0 ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-500"
          }`}
        >
          {total}
        </span>
      </div>

      {appointments.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-gray-500">{t("dashboard.to_confirm_empty")}</p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 -mx-2">
          {appointments.map((apt) => (
            <li key={apt.id}>
              <Link
                href={`/dashboard/appointments/${apt.id}`}
                className="flex items-center justify-between px-2 py-2.5 rounded-lg hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 bg-amber-50 rounded-full flex items-center justify-center flex-shrink-0">
                    <User className="w-4 h-4 text-amber-600" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 text-sm truncate">
                      {personName(apt.client) || t("dashboard.unknown_client")}
                    </p>
                    <p className="text-xs text-gray-500 truncate">{apt.service?.name ?? "—"}</p>
                  </div>
                </div>
                <div className="text-right flex-shrink-0 ml-3">
                  <p className="text-xs font-medium text-gray-700">{formatDay(apt.scheduledDate)}</p>
                  <p className="text-xs text-gray-500 flex items-center justify-end gap-1">
                    <Clock className="w-3 h-3" aria-hidden />
                    {apt.scheduledTime}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 pt-4 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2">
        {total > appointments.length && appointments.length > 0 && (
          <span className="text-xs text-gray-500">
            {t("dashboard.showing_of", { shown: appointments.length, total })}
          </span>
        )}
        <Link href={AGENDA_FOCUS_HREF.pending} className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
          {t("dashboard.to_confirm_view_all")}
        </Link>
      </div>
    </div>
  );
};
