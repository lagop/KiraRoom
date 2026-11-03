"use client";

import React from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle, Clock, UserCircle } from "lucide-react";
import { agendaByProfessional, countKey, isPast, personName, statusLabelKey } from "@/lib/home-dashboard";
import { useTranslations } from "@/lib/use-translation";
import type { HomeAppointmentRow } from "./use-dashboard-data";

interface ProfessionalAgendaProps {
  /** The team (of the location); a professional: themselves. */
  professionals: { id: string; firstName: string; lastName: string }[];
  /** Today's appointments still to be served, by time. */
  appointments: HomeAppointmentRow[];
  /** The salon's clock ("HH:mm"): what is behind it is shown faded. */
  now: string;
  /** A professional's own agenda ("Tu agenda de hoy"). */
  own: boolean;
  className?: string;
}

const STATUS_PILL: Record<string, string> = {
  in_progress: "bg-blue-100 text-blue-800",
  confirmed: "bg-purple-100 text-purple-800",
  pending: "bg-yellow-100 text-yellow-800",
};

/**
 * "Agenda de hoy por profesional" (D30): one column per professional with
 * today's appointments, those with nothing booked included, so who is busy
 * and who is free reads at a glance.
 */
export const ProfessionalAgenda: React.FC<ProfessionalAgendaProps> = ({
  professionals,
  appointments,
  now,
  own,
  className = "",
}) => {
  const t = useTranslations();
  const groups = agendaByProfessional(professionals, appointments);

  return (
    <div className={`bg-white rounded-xl border border-gray-200 p-6 ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">
          {own ? t("dashboard.my_agenda_today") : t("dashboard.agenda_by_professional")}
        </h2>
        <Link href="/dashboard/appointments" className="text-sm text-purple-600 hover:text-purple-700">
          {t("dashboard.view_all")}
        </Link>
      </div>

      {groups.length === 0 ? (
        <div className="text-center py-8 text-gray-500">{t("dashboard.no_appointments_today")}</div>
      ) : (
        <div className={`grid grid-cols-1 gap-4 ${groups.length > 1 ? "sm:grid-cols-2" : ""}`}>
          {groups.map((group) => (
            <section
              key={group.professional?.id ?? "none"}
              className="rounded-lg border border-gray-100 bg-gray-50 p-3"
              aria-label={personName(group.professional) || t("dashboard.no_professional")}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="flex items-center gap-2 min-w-0 font-medium text-gray-900">
                  <UserCircle className="w-5 h-5 text-indigo-500 flex-shrink-0" aria-hidden />
                  <span className="truncate">
                    {personName(group.professional) || t("dashboard.no_professional")}
                  </span>
                </p>
                <span className="text-xs text-gray-500 flex-shrink-0">
                  {group.appointments.length === 0
                    ? t("dashboard.free_today")
                    : t(countKey("dashboard.appointments_count", group.appointments.length), {
                        count: group.appointments.length,
                      })}
                </span>
              </div>
              {group.appointments.length > 0 && (
                <ul className="space-y-1.5">
                  {group.appointments.map((apt) => (
                    <li key={apt.id}>
                      <Link
                        href={`/dashboard/appointments/${apt.id}`}
                        className={`flex items-center justify-between gap-2 rounded-md bg-white px-2 py-1.5 text-sm hover:bg-indigo-50 ${
                          isPast(apt, now) ? "opacity-60" : ""
                        }`}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="font-medium text-gray-900 tabular-nums">{apt.scheduledTime}</span>
                          <span className="min-w-0 truncate text-gray-700">
                            {personName(apt.client) || t("dashboard.unknown_client")}
                            {apt.service?.name && <span className="text-gray-400"> · {apt.service.name}</span>}
                          </span>
                        </span>
                        <span
                          className={`inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            STATUS_PILL[apt.status] ?? "bg-gray-100 text-gray-800"
                          }`}
                        >
                          {apt.status === "confirmed" && <CheckCircle className="w-3 h-3 mr-1" aria-hidden />}
                          {apt.status === "in_progress" && <Clock className="w-3 h-3 mr-1" aria-hidden />}
                          {apt.status === "pending" && <AlertCircle className="w-3 h-3 mr-1" aria-hidden />}
                          {t(statusLabelKey(apt.status))}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
};
