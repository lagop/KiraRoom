"use client";

import { useEffect, useState } from "react";
import apiClient from "./api";
import { NO_BOOKING_LOCATIONS, type BookingLocations } from "./panel-booking-locations";

/**
 * The salon's locations for the panel's booking forms and the agenda filter
 * (lib/panel-booking-locations.ts). Fetched once and shared by the agenda,
 * the drawer and the calendar popovers for a few minutes. Any failure, or a
 * salon with a single location, gives none: the panel books as before.
 */
const FRESH_MS = 5 * 60 * 1000;
let cached: { at: number; data: Promise<BookingLocations> } | null = null;

function load(): Promise<BookingLocations> {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.data;
  const data = apiClient
    .getBookingLocations()
    .then((d) => (d && Array.isArray(d.locations) && Array.isArray(d.professionals) ? d : NO_BOOKING_LOCATIONS))
    .catch(() => {
      cached = null;
      return NO_BOOKING_LOCATIONS;
    });
  cached = { at: Date.now(), data };
  return data;
}

export function useBookingLocations(enabled = true): BookingLocations {
  const [data, setData] = useState<BookingLocations>(NO_BOOKING_LOCATIONS);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void load().then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return data;
}
