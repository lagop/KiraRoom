// components/calendar/SalonTimeZone.tsx
import React, { createContext, useContext } from "react";
import { FALLBACK_SALON_TIMEZONE } from "./salon-time";

/**
 * The salon's IANA zone (Tenant.timezone), for every piece of the calendar
 * that turns an instant into a clock time. Calendar.tsx provides it.
 */
const SalonTimeZoneContext = createContext<string>(FALLBACK_SALON_TIMEZONE);

export const SalonTimeZoneProvider: React.FC<{ timeZone: string; children: React.ReactNode }> = ({
  timeZone,
  children,
}) => <SalonTimeZoneContext.Provider value={timeZone}>{children}</SalonTimeZoneContext.Provider>;

export function useSalonTimeZone(): string {
  return useContext(SalonTimeZoneContext);
}
