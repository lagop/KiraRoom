// components/calendar/TimeGrid.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Professional } from "./types";
import { ProfessionalColumn } from "./ProfessionalColumn";
import { Appointment } from "./types";
import { SlotClickData } from "./TimeSlot";
import { pickedDay, salonClock } from "./salon-time";
import { useSalonTimeZone } from "./SalonTimeZone";
import { HEADER_HEIGHT, HOUR_HEIGHT, minutesToTop, type HoursRange } from "./day-grid";
import type { TimeOff } from "@/lib/time-off";

interface TimeGridProps {
  date: Date;
  hours: HoursRange;
  professionals: Professional[];
  appointments: Appointment[];
  /** The day's time off and closures. */
  timeOff?: TimeOff[];
  draggingId?: string | null;
  onAppointmentClick?: (appointmentId: string) => void;
  onSlotClick?: (data: SlotClickData) => void;
  onEditClick?: (appointmentId: string) => void;
  t: (key: string, params?: Record<string, any>) => string;
}

/** The clock, re-read at the start of every minute. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);
  return now;
}

/**
 * The day's hours, one column per professional. It has no scroll of its own:
 * the calendar's scroll box around it scrolls both ways, and the hours (left)
 * and the professionals' row (top) stay in place, sticky to that box.
 */
export const TimeGrid: React.FC<TimeGridProps> = ({
  date,
  hours: range,
  professionals,
  appointments,
  timeOff = [],
  draggingId,
  onAppointmentClick,
  onSlotClick,
  onEditClick,
  t,
}) => {
  const timeZone = useSalonTimeZone();
  const now = useMinuteClock();
  const hours = useMemo(
    () =>
      Array.from({ length: range.endHour - range.startHour }, (_, i) => range.startHour + i),
    [range.startHour, range.endHour]
  );

  // The salon's "now", on the salon's today. It used to be computed once and
  // never moved.
  const nowTop = useMemo(() => {
    const clock = salonClock(now, timeZone);
    if (clock.day !== pickedDay(date)) return null;
    return minutesToTop(clock.minutes, range.startHour);
  }, [now, date, timeZone, range.startHour]);

  return (
    <div className="relative w-max min-w-full" data-test="time-grid">
      <div className="flex">
        <div className="w-16 shrink-0 border-r bg-background sticky left-0 z-20">
          <div className="h-12 border-b bg-background sticky top-0 z-10" />
          {hours.map((hour, i) => (
            <div key={hour} className="h-24 relative">
              <span
                className={`absolute left-2 text-xs text-muted-foreground ${i === 0 ? "top-0.5" : "-top-2"}`}
              >
                {hour.toString().padStart(2, "0")}:00
              </span>
            </div>
          ))}
        </div>
        {professionals.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-8 text-sm text-muted-foreground">
            {t("appointments.calendarView.noProfessionals")}
          </div>
        ) : (
          professionals.map((professional) => (
            <ProfessionalColumn
              key={professional.id}
              professional={professional}
              date={date}
              hours={range}
              appointments={appointments.filter(
                (a) => a.professionalId === professional.id
              )}
              timeOff={timeOff}
              draggingId={draggingId}
              onAppointmentClick={onAppointmentClick}
              onSlotClick={onSlotClick}
              onEditClick={onEditClick}
              t={t}
            />
          ))
        )}
      </div>
      {nowTop !== null &&
        nowTop >= 0 &&
        nowTop <= (range.endHour - range.startHour) * HOUR_HEIGHT && (
          <div
            className="absolute left-16 right-0 h-0.5 bg-red-500 z-[5] pointer-events-none"
            style={{ top: nowTop + HEADER_HEIGHT }}
          >
            {/* Right of the hours, which stay on top while scrolling sideways. */}
            <div className="absolute left-0 -top-[5px] w-3 h-3 bg-red-500 rounded-full" />
          </div>
        )}
    </div>
  );
};
