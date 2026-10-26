"use client";

import React from "react";
import { Clock } from "lucide-react";
import { suggestedSalonTimezone, salonTimezoneLabel, type SalonAddress } from "@kira/shared";

/**
 * Said where a salon's address is in the Canary Islands while it is on
 * Madrid time, the zone every sign-up started on: its calendar and reminders
 * would be an hour off. Saving the address switches it (PATCH /auth/tenant);
 * `onApply`, when given, offers the switch right here instead.
 */
export function CanaryTimezoneHint({
  timezone,
  address,
  onApply,
}: {
  /** The salon's zone as saved (or as picked on the form). */
  timezone: string | null | undefined;
  address: SalonAddress;
  onApply?: (timezone: string) => void;
}) {
  const suggested = suggestedSalonTimezone(timezone, address);
  if (!suggested) return null;
  return (
    <div
      role="status"
      data-test="canary-timezone-hint"
      className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
    >
      <Clock className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <div className="space-y-1">
        <p>
          La dirección del salón está en Canarias, pero el salón usa la hora de la Península: las citas y los
          recordatorios irían con una hora de diferencia.
          {onApply ? "" : ` Al guardar, pasará a ${salonTimezoneLabel(suggested)}.`}
        </p>
        {onApply && (
          <button
            type="button"
            onClick={() => onApply(suggested)}
            className="font-medium text-amber-900 underline hover:no-underline"
          >
            Usar {salonTimezoneLabel(suggested)}
          </button>
        )}
      </div>
    </div>
  );
}
