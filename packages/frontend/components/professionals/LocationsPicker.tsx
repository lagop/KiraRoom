"use client";

import React, { useEffect, useState } from "react";
import { MapPin } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import {
  assignableLocations,
  makePrimary,
  toggleLocation,
  type LocationChoice,
} from "@/lib/professional-locations";

interface SalonLocation {
  id: string;
  name: string;
  isActive?: boolean;
}

interface LocationsPickerProps {
  value: LocationChoice;
  onChange: (next: LocationChoice) => void;
  disabled?: boolean;
}

/**
 * Which of the salon's locations a professional works at (multi-local plan).
 * Shows nothing when the salon has no locations or the plan does not include
 * them (GET /locations answers 403), so the form never sends the field then.
 */
export function LocationsPicker({ value, onChange, disabled }: LocationsPickerProps) {
  const t = useTranslations();
  const [locations, setLocations] = useState<SalonLocation[]>([]);

  useEffect(() => {
    let alive = true;
    apiClient
      .request("/locations")
      .then((data) => {
        if (alive) setLocations(assignableLocations(Array.isArray(data) ? (data as SalonLocation[]) : []));
      })
      .catch(() => {
        if (alive) setLocations([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (locations.length === 0) return null;

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700">{t("professionals.fields.locations")}</label>
      <p className="text-xs text-gray-500">{t("professionals.fields.locationsHint")}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {locations.map((location) => {
          const ticked = value.ids.includes(location.id);
          const main = ticked && value.primary === location.id;
          return (
            <div
              key={location.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 px-3 py-2"
            >
              <label className="flex min-w-0 cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-gray-300"
                  checked={ticked}
                  disabled={disabled}
                  onChange={() => onChange(toggleLocation(value, location.id))}
                />
                <MapPin className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
                <span className="truncate text-sm text-gray-900">{location.name}</span>
              </label>
              {main ? (
                <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                  {t("professionals.fields.mainLocation")}
                </span>
              ) : ticked && value.ids.length > 1 ? (
                <button
                  type="button"
                  className="shrink-0 text-xs text-gray-500 underline hover:text-gray-900"
                  disabled={disabled}
                  onClick={() => onChange(makePrimary(value, location.id))}
                >
                  {t("professionals.fields.makeMain")}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
