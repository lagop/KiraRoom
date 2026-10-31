import React from "react";
import { useTranslations } from "@/lib/use-translation";
import {
  effectiveCommission,
  formatCents,
  formatRate,
  parseRate,
  type SalonTermsForm,
} from "../../appointment-drawer.utils";
import type { Appointment } from "../types";

/**
 * The salon's terms on an appointment: the professional's commission and
 * the deposit. Owner and managers only (the server ignores them from a
 * professional), so the drawer renders this card only for them.
 *
 * The commission shown is the one that applies: the appointment's own
 * (0 % included), else the professional's, else the salon's default. Left
 * empty in the form, the appointment takes the professional's again.
 */
export interface SalonTermsCardProps {
  appointment: Appointment;
  editMode: boolean;
  form: SalonTermsForm | null;
  onChange: (form: SalonTermsForm) => void;
}

const inputClass =
  "w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none";

export function SalonTermsCard({ appointment, editMode, form, onChange }: SalonTermsCardProps) {
  const t = useTranslations();
  const applied = effectiveCommission(appointment.commissionRate, appointment.professionalCommissionRate);
  const fallback = effectiveCommission(null, appointment.professionalCommissionRate);
  const sourceLabel =
    applied.source === "appointment"
      ? t("appointments.commission_source_appointment")
      : applied.source === "professional"
        ? t("appointments.commission_source_professional")
        : t("appointments.commission_source_default");
  const deposit = Number(appointment.depositAmount) || 0;

  if (editMode && form) {
    const typed = parseRate(form.commission);
    const invalid = form.commission.trim() !== "" && typed === null;
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 space-y-4">
        <div>
          <label htmlFor="appointment-commission" className="block text-sm font-medium text-gray-700 mb-1">
            {t("appointments.commission_rate")} (%)
          </label>
          <input
            id="appointment-commission"
            type="number"
            min="0"
            max="100"
            step="0.5"
            value={form.commission}
            onChange={(e) => onChange({ ...form, commission: e.target.value })}
            className={inputClass}
            placeholder={t("appointments.commission_placeholder", { rate: formatRate(fallback.rate) })}
            aria-invalid={invalid}
          />
          <p className={`text-sm mt-1 ${invalid ? "text-red-600" : "text-gray-500"}`}>
            {invalid ? t("appointments.commission_invalid") : t("appointments.commission_rate_description")}
          </p>
        </div>
        <div>
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={form.depositRequired}
              onChange={(e) => onChange({ ...form, depositRequired: e.target.checked })}
              className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
            />
            <span className="ml-2 text-gray-700">{t("appointments.require_deposit")}</span>
          </label>
          {form.depositRequired && (
            <div className="mt-2">
              <label htmlFor="appointment-deposit" className="block text-sm font-medium text-gray-700 mb-1">
                {t("appointments.deposit_amount")}
              </label>
              <input
                id="appointment-deposit"
                type="number"
                step="0.01"
                min="0"
                value={form.deposit}
                onChange={(e) => onChange({ ...form, deposit: e.target.value })}
                className={inputClass}
                placeholder={t("appointments.deposit_amount_placeholder")}
              />
              {appointment.depositPaid && (
                <p className="text-sm text-amber-700 mt-1">{t("appointments.deposit_already_paid")}</p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-2">{t("appointments.commission_rate")}</h2>
        <p className="text-lg font-medium text-indigo-600">{formatRate(applied.rate)}</p>
        <p className="text-sm text-gray-500">{sourceLabel}</p>
      </div>
      <div>
        <h3 className="text-sm font-medium text-gray-900 mb-1">{t("appointments.deposit")}</h3>
        {appointment.depositRequired ? (
          <p className="text-sm text-gray-700">
            {formatCents(deposit)}{" "}
            <span className={appointment.depositPaid ? "text-green-700" : "text-amber-700"}>
              ({appointment.depositPaid ? t("appointments.deposit_paid") : t("appointments.deposit_pending")})
            </span>
          </p>
        ) : (
          <p className="text-sm text-gray-500">{t("appointments.no_deposit")}</p>
        )}
      </div>
    </div>
  );
}
