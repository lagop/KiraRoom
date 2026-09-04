"use client";

import React from "react";
import Link from "next/link";
import { CreditCard, User, Clock } from "lucide-react";
import type { PendingPaymentAppointment } from "./use-dashboard-data";

interface PendingPaymentsWidgetProps {
  appointments: PendingPaymentAppointment[];
  className?: string;
}

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
};

/**
 * The backend stores monetary amounts in **cents** (see the
 * `totalAmount` / `amountPaid` / `amountDue` columns on the
 * appointments table) so we divide by 100 before display.
 */
const formatMoney = (amount: number) => {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
  }).format(amount / 100);
};

const getClientName = (
  client: PendingPaymentAppointment["client"],
): string => {
  if (!client) return "Unknown client";
  if (typeof client === "string") return client;
  return `${client.firstName} ${client.lastName}`.trim();
};

const getServiceName = (
  service: PendingPaymentAppointment["service"],
): string => {
  if (!service) return "—";
  if (typeof service === "string") return service;
  return service.name;
};

/**
 * Highlights appointments whose payment is still pending — typically
 * the most actionable revenue-recovery widget for salon owners.
 *
 * Each row shows the client, service, scheduled date/time, and the
 * outstanding amount (computed from totalAmount - amountPaid when the
 * API doesn't already expose `amountDue`). The whole row links to the
 * appointment page so the owner can record payment in one click.
 */
export const PendingPaymentsWidget: React.FC<PendingPaymentsWidgetProps> = ({
  appointments,
  className = "",
}) => {
  const totalDue = appointments.reduce((sum, a) => {
    const due =
      a.amountDue !== undefined
        ? a.amountDue
        : Math.max((a.totalAmount ?? 0) - (a.amountPaid ?? 0), 0);
    return sum + due;
  }, 0);

  return (
    <div
      className={`bg-white rounded-xl border border-gray-200 p-6 ${className}`}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-red-50 rounded-lg">
            <CreditCard className="w-4 h-4 text-red-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">
            Pending payments
          </h2>
        </div>
        {totalDue > 0 && (
          <span className="text-sm font-semibold text-red-700">
            {formatMoney(totalDue)}
          </span>
        )}
      </div>

      {appointments.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-gray-500">
            No outstanding payments. Nice.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-gray-100 -mx-2">
          {appointments.map((apt) => {
            const due =
              apt.amountDue !== undefined
                ? apt.amountDue
                : Math.max((apt.totalAmount ?? 0) - (apt.amountPaid ?? 0), 0);
            return (
              <li key={apt.id}>
                <Link
                  href={`/dashboard/appointments/${apt.id}`}
                  className="flex items-center justify-between px-2 py-2.5 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 bg-red-50 rounded-full flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4 text-red-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 text-sm truncate">
                        {getClientName(apt.client)}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {getServiceName(apt.service)}
                      </p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 ml-3">
                    <p className="text-sm font-semibold text-red-700">
                      {formatMoney(due)}
                    </p>
                    <p className="text-xs text-gray-500 flex items-center justify-end gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDate(apt.scheduledDate)} · {apt.scheduledTime}
                    </p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 pt-4 border-t border-gray-100">
        <Link
          href="/dashboard/appointments?paymentStatus=pending"
          className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
        >
          View all pending payments →
        </Link>
      </div>
    </div>
  );
};
