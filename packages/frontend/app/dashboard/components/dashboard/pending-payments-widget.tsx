"use client";

import React from "react";
import Link from "next/link";
import { CreditCard, User, Clock } from "lucide-react";
import { formatCents, formatDay } from "@/lib/analytics-format";
import { AGENDA_FOCUS_HREF, countKey, personName } from "@/lib/home-dashboard";
import { useTranslations } from "@/lib/use-translation";
import type { HomeAppointmentRow } from "./use-dashboard-data";

interface PendingPaymentsWidgetProps {
  /** The latest few visits still owed. */
  appointments: HomeAppointmentRow[];
  /** How many visits are owed in all. */
  total: number;
  /** What they owe in all, in cents (money, tax included). */
  totalDue: number;
  className?: string;
}

/**
 * Visits up to today still to charge: the latest ones, how many there are
 * and how much is owed in all. The count and the sum used to be of the five
 * shown.
 */
export const PendingPaymentsWidget: React.FC<PendingPaymentsWidgetProps> = ({
  appointments,
  total,
  totalDue,
  className = "",
}) => {
  const t = useTranslations();
  return (
    <div className={`bg-white rounded-xl border border-gray-200 p-6 ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-red-50 rounded-lg">
            <CreditCard className="w-4 h-4 text-red-600" aria-hidden />
          </div>
          <h2 className="text-base font-semibold text-gray-900">{t("dashboard.to_charge_title")}</h2>
        </div>
        {total > 0 && (
          <span className="text-right">
            <span className="block text-sm font-semibold text-red-700">{formatCents(totalDue)}</span>
            <span className="block text-xs text-gray-500">
              {t(countKey("dashboard.to_charge_count", total), { count: total })}
            </span>
          </span>
        )}
      </div>

      {appointments.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-gray-500">{t("dashboard.to_charge_empty")}</p>
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
                  <div className="w-8 h-8 bg-red-50 rounded-full flex items-center justify-center flex-shrink-0">
                    <User className="w-4 h-4 text-red-600" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900 text-sm truncate">
                      {personName(apt.client) || t("dashboard.unknown_client")}
                    </p>
                    <p className="text-xs text-gray-500 truncate">{apt.service?.name ?? "—"}</p>
                  </div>
                </div>
                <div className="text-right flex-shrink-0 ml-3">
                  <p className="text-sm font-semibold text-red-700">{formatCents(apt.amountDue ?? 0)}</p>
                  <p className="text-xs text-gray-500 flex items-center justify-end gap-1">
                    <Clock className="w-3 h-3" aria-hidden />
                    {formatDay(apt.scheduledDate)} · {apt.scheduledTime}
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
        <Link href={AGENDA_FOCUS_HREF.unpaid} className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
          {t("dashboard.to_charge_view_all")}
        </Link>
      </div>
    </div>
  );
};
