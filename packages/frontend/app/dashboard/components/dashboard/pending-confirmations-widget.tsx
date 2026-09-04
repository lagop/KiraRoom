"use client";

import React from "react";
import Link from "next/link";
import { AlertCircle, Clock, User } from "lucide-react";
import type { UpcomingAppointment } from "./use-dashboard-data";

interface PendingConfirmationsWidgetProps {
  appointments: UpcomingAppointment[];
  className?: string;
}

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
};

const getClientName = (client: UpcomingAppointment["client"]) => {
  if (!client) return "Unknown client";
  if (typeof client === "string") return client;
  return `${client.firstName} ${client.lastName}`.trim();
};

const getServiceName = (service: UpcomingAppointment["service"]) => {
  if (!service) return "—";
  if (typeof service === "string") return service;
  return service.name;
};

/**
 * Compact list of appointments still in `pending` status, surfaced
 * on the dashboard overview. Each row links to the appointment
 * detail page so the salon owner can confirm/reject with one click.
 *
 * Renders nothing more than a header + the list when there are no
 * pending appointments, so it slots cleanly into the dashboard grid
 * without visual noise.
 */
export const PendingConfirmationsWidget: React.FC<
  PendingConfirmationsWidgetProps
> = ({ appointments, className = "" }) => {
  return (
    <div
      className={`bg-white rounded-xl border border-gray-200 p-6 ${className}`}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-amber-50 rounded-lg">
            <AlertCircle className="w-4 h-4 text-amber-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">
            Awaiting confirmation
          </h2>
        </div>
        <span
          className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
            appointments.length > 0
              ? "bg-amber-100 text-amber-800"
              : "bg-gray-100 text-gray-500"
          }`}
        >
          {appointments.length}
        </span>
      </div>

      {appointments.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-gray-500">
            All caught up — no pending appointments.
          </p>
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
                    <User className="w-4 h-4 text-amber-600" />
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
                  <p className="text-xs font-medium text-gray-700">
                    {formatDate(apt.scheduledDate)}
                  </p>
                  <p className="text-xs text-gray-500 flex items-center justify-end gap-1">
                    <Clock className="w-3 h-3" />
                    {apt.scheduledTime}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 pt-4 border-t border-gray-100">
        <Link
          href="/dashboard/appointments?status=pending"
          className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
        >
          View all pending →
        </Link>
      </div>
    </div>
  );
};
