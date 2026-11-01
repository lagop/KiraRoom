"use client";

import type { BookingLocations } from "@/lib/panel-booking-locations";

/**
 * The salon's locations as a dropdown (multi-local): booking, editing and
 * the agenda filter. Render it only when the salon has a choice
 * (hasLocations); `emptyLabel` adds a first option with no location (the
 * professional's main one, or all of them in a filter).
 */
export function LocationSelect({
  data,
  value,
  onChange,
  label,
  emptyLabel,
  only,
  className,
  id,
}: {
  data: BookingLocations;
  value: string;
  onChange: (locationId: string) => void;
  label: string;
  emptyLabel?: string;
  /** Limit the options to these locations (still showing the current one). */
  only?: string[];
  className?: string;
  id?: string;
}) {
  const options = only ? data.locations.filter((l) => only.includes(l.id) || l.id === value) : data.locations;
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={
        className ??
        "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
      }
    >
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {options.map((l) => (
        <option key={l.id} value={l.id}>
          {l.name}
        </option>
      ))}
    </select>
  );
}
