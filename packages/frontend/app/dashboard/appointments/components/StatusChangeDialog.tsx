"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useTranslations } from "@/lib/use-translation";
import type { AskedStatus } from "./appointment-drawer.utils";

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
  onCancel: () => void;
  onConfirm: (reason?: string) => void;
}) {
  const t = useTranslations();
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (to) setReason("");
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
          </div>
        }
        confirmLabel={t("appointments.cancel_appointment")}
        cancelLabel={t("appointments.keep_appointment")}
        destructive
        loading={loading}
        onCancel={onCancel}
        onConfirm={() => onConfirm(reason)}
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
