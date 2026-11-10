"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useTranslations } from "@/lib/use-translation";
import type { AskedStatus } from "./appointment-drawer.utils";
import { euros } from "@/lib/booking-payment";

/**
 * Asks before the status changes that cannot be taken back lightly:
 * cancelling (with an optional reason, which goes in the notice and the
 * appointment's history), marking a no-show, and completing (final, and
 * the salon's automatic invoice is issued from it).
 */
export function StatusChangeDialog({
  to,
  loading,
  portal = true,
  paidOnlineCents = 0,
  onCancel,
  onConfirm,
}: {
  /** Which change is being asked about; null renders nothing. */
  to: AskedStatus | null;
  loading?: boolean;
  /**
   * Render over the whole page (default). Inside the drawer, which is a modal
   * Radix dialog, it must render in place: the drawer blocks pointer events
   * and focus outside itself.
   */
  portal?: boolean;
  /** What the client paid online and the salon holds (cents): cancelling gives it back, unless the salon keeps it. */
  paidOnlineCents?: number;
  onCancel: () => void;
  onConfirm: (reason?: string, opts?: { keepOnlinePayment?: boolean }) => void;
}) {
  const t = useTranslations();
  const [reason, setReason] = useState("");
  const [keepPayment, setKeepPayment] = useState(false);
  useEffect(() => {
    if (to) {
      setReason("");
      setKeepPayment(false);
    }
  }, [to]);

  if (!to || typeof document === "undefined") return null;

  const dialog =
    to === "cancelled" ? (
      <ConfirmDialog
        open
        title={t("appointments.cancel_appointment_confirm")}
        description={
          <div className="space-y-3">
            <p>{t("appointments.cancel_notice")}</p>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-700">
                {t("appointments.cancel_reason")}
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
                rows={3}
                autoFocus
                placeholder={t("appointments.cancel_reason_placeholder")}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </label>
            {paidOnlineCents > 0 && (
              <div data-test="cancel-online-payment" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p>
                  Esta cita tiene {euros(paidOnlineCents)} pagados online.{" "}
                  {keepPayment
                    ? "Te los quedas: no se devuelve nada a la clienta."
                    : "Al cancelarla se le devuelven automáticamente a la clienta."}
                </p>
                <label className="mt-2 flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={keepPayment}
                    onChange={(e) => setKeepPayment(e.target.checked)}
                  />
                  <span>No devolver el pago (cancelación tardía)</span>
                </label>
              </div>
            )}
          </div>
        }
        confirmLabel={t("appointments.cancel_appointment")}
        cancelLabel={t("appointments.keep_appointment")}
        destructive
        loading={loading}
        onCancel={onCancel}
        onConfirm={() => onConfirm(reason, paidOnlineCents > 0 && keepPayment ? { keepOnlinePayment: true } : undefined)}
      />
    ) : to === "completed" ? (
      <ConfirmDialog
        open
        title={t("appointments.complete_confirm")}
        description={t("appointments.complete_notice")}
        confirmLabel={t("appointments.mark_completed")}
        cancelLabel={t("appointments.not_yet")}
        loading={loading}
        onCancel={onCancel}
        onConfirm={() => onConfirm()}
      />
    ) : (
      <ConfirmDialog
        open
        title={t("appointments.no_show_confirm")}
        description={t("appointments.no_show_notice")}
        confirmLabel={t("appointments.no_show")}
        cancelLabel={t("appointments.keep_appointment")}
        loading={loading}
        onCancel={onCancel}
        onConfirm={() => onConfirm()}
      />
    );

  return portal ? createPortal(dialog, document.body) : dialog;
}
