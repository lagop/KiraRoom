// components/calendar/TimeGrid.tsx
import React, { useMemo } from "react";
import { isToday } from "date-fns";
import { Professional } from "./types";
import { ProfessionalColumn } from "./ProfessionalColumn";
import { Appointment } from "./types";
import { SlotClickData } from "./TimeSlot";

interface TimeGridProps {
  date: Date;
  professionals: Professional[];
  appointments: Appointment[];
  draggingId?: string | null;
  onAppointmentClick?: (appointmentId: string) => void;
  onSlotClick?: (data: SlotClickData) => void;
  onEditClick?: (appointmentId: string) => void;
}

const HOUR_HEIGHT = 96; // 24px * 4 slots
const START_HOUR = 8;
const END_HOUR = 20;

export const TimeGrid: React.FC<TimeGridProps> = ({
  date,
  professionals,
  appointments,
  draggingId,
  onAppointmentClick,
  onSlotClick,
  onEditClick,
}) => {
  const hours = useMemo(
    () =>
      Array.from({ length: END_HOUR - START_HOUR }, (_, i) => START_HOUR + i),
    []
  );

  const nowTop = useMemo(() => {
    if (!isToday(date)) return null;
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = START_HOUR * 60;
    return ((minutes - startMinutes) / 15) * 24;
  }, [date]);

  return (
    <div className="relative min-w-[640px] md:min-w-0" data-test="time-grid">
      <div className="flex">
        <div className="w-16 shrink-0 border-r bg-background sticky left-0 z-10">
          <div className="h-12 border-b" />
          {hours.map((hour) => (
            <div key={hour} className="h-24 relative">
              <span className="absolute -top-2 left-2 text-xs text-muted-foreground">
                {hour.toString().padStart(2, "0")}:00
              </span>
            </div>
          ))}
        </div>
        {professionals.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-8 text-sm text-muted-foreground">
            Sin profesionales este día
          </div>
        ) : (
          professionals.map((professional) => (
            <ProfessionalColumn
              key={professional.id}
              professional={professional}
              date={date}
              appointments={appointments.filter(
                (a) => a.professionalId === professional.id
              )}
              draggingId={draggingId}
              onAppointmentClick={onAppointmentClick}
              onSlotClick={onSlotClick}
              onEditClick={onEditClick}
            />
          ))
        )}
      </div>
      {nowTop !== null &&
        nowTop >= 0 &&
        nowTop <= (END_HOUR - START_HOUR) * HOUR_HEIGHT && (
          <div
            className="absolute left-16 right-0 h-0.5 bg-red-500 z-20"
            style={{ top: nowTop + 48 }}
          >
            <div className="absolute -left-2 -top-2 w-4 h-4 bg-red-500 rounded-full" />
          </div>
        )}
    </div>
  );
};
