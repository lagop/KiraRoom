import React from "react";
import { useTranslations } from "@/lib/use-translation";
import {
  appointmentTotalCents,
  calculateTotalDuration,
  formatCents,
  formatEuros,
} from "../../appointment-drawer.utils";
import type { Appointment } from "../types";

/**
 * What the visit costs: each service, the add-ons, the total, and what has
 * been paid. Prices are in euros; the server's total, what is paid and the
 * deposit are in cents (see appointment-drawer.utils "Money").
 *
 * Viewing, the total is the server's (it adds up every service and add-on).
 * Editing, it is worked out from the form, as the server will once saved.
 */
export interface PaymentSummaryCardProps {
  appointment: Appointment;
  editMode: boolean;
  /** Editing a single-service appointment: the service picked in the form. */
  editedServicePrice?: number;
  currentAddons: Appointment["addons"];
}

export function PaymentSummaryCard({
  appointment,
  editMode,
  editedServicePrice,
  currentAddons,
}: PaymentSummaryCardProps) {
  const t = useTranslations();
  const isMulti = !!appointment.services && appointment.services.length > 0;
  const addons = editMode ? currentAddons : appointment.addons;
  const addonsEuros = (addons ?? []).reduce(
    (sum, addon) => sum + (Number(addon.price) || 0) * (Number(addon.quantity) || 0),
    0,
  );
  const servicePrice =
    editMode && editedServicePrice !== undefined ? editedServicePrice : appointment.service.price;

  const editedTotalEuros =
    (isMulti
      ? appointment.services!.reduce((sum, s) => sum + (Number(s.service?.price) || 0), 0)
      : Number(servicePrice) || 0) + addonsEuros;
  const total = editMode ? formatEuros(editedTotalEuros) : formatCents(appointmentTotalCents(appointment));
  const paid = Number(appointment.amountPaid) || 0;
  const deposit = Number(appointment.depositAmount) || 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("appointments.payment_summary")}</h2>
      <div className="space-y-3">
        {isMulti ? (
          appointment.services!.map((row, index) => (
            <div key={row.id || index} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-gray-600 min-w-0 truncate">
                {row.service?.name || t("appointments.service")}{" "}
                {row.isParallel && `(${t("appointments.parallel")})`}
              </span>
              <span className="font-medium text-gray-900 whitespace-nowrap">
                {formatEuros(row.service?.price)}
              </span>
            </div>
          ))
        ) : (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="text-gray-600">{t("appointments.service")}</span>
            <span className="font-medium text-gray-900 whitespace-nowrap">{formatEuros(servicePrice)}</span>
          </div>
        )}
        {(addons ?? []).map((addon) => (
          <div key={addon.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-gray-600 min-w-0 truncate">
              {addon.name} × {addon.quantity}
            </span>
            <span className="font-medium text-gray-900 whitespace-nowrap">
              {formatEuros((Number(addon.price) || 0) * (Number(addon.quantity) || 0))}
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-600">{t("appointments.duration")}</span>
          <span className="font-medium text-gray-900">{calculateTotalDuration(appointment)} min</span>
        </div>
        <div className="border-t border-gray-200 pt-3">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-gray-900">{t("appointments.total")}</span>
            <span className="text-xl font-bold text-gray-900">{total}</span>
          </div>
          {!editMode && paid > 0 && (
            <div className="flex items-center justify-between text-sm mt-2">
              <span className="text-gray-600">{t("appointments.amount_paid")}</span>
              <span className="font-medium text-green-700">{formatCents(paid)}</span>
            </div>
          )}
          {!editMode && appointment.depositRequired && deposit > 0 && (
            <div className="flex items-center justify-between text-sm mt-2">
              <span className="text-gray-600">{t("appointments.deposit")}</span>
              <span className="font-medium text-gray-900">
                {formatCents(deposit)}{" "}
                <span className={appointment.depositPaid ? "text-green-700" : "text-amber-700"}>
                  ({appointment.depositPaid ? t("appointments.deposit_paid") : t("appointments.deposit_pending")})
                </span>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
