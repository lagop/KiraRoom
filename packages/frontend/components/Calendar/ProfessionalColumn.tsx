// components/calendar/ProfessionalColumn.tsx
import React, { useMemo } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useDroppable } from "@dnd-kit/core";
import { Professional, Appointment } from "./types";
import { TimeSlot, SlotClickData } from "./TimeSlot";
import { AppointmentBlock } from "./AppointmentBlock";
import { holdsSlot, layoutLanes, type HoursRange } from "./day-grid";

interface ProfessionalColumnProps {
  professional: Professional;
  date: Date;
  hours: HoursRange;
  appointments: Appointment[];
  draggingId?: string | null;
  onAppointmentClick?: (appointmentId: string) => void;
  onSlotClick?: (data: SlotClickData) => void;
  onEditClick?: (appointmentId: string) => void;
  t: (key: string, params?: Record<string, any>) => string;
}

/** Narrowest a lane of overlapping appointments gets before the grid scrolls sideways. */
const LANE_MIN_WIDTH = 140;
const COLUMN_MIN_WIDTH = 208;

export const ProfessionalColumn: React.FC<ProfessionalColumnProps> = ({
  professional,
  date,
  hours,
  appointments,
  draggingId,
  onAppointmentClick,
  onSlotClick,
  onEditClick,
  t,
}) => {
  const slots = useMemo(
    () =>
      Array.from({ length: (hours.endHour - hours.startHour) * 4 }, (_, i) => ({
        hour: hours.startHour + Math.floor(i / 4),
        minute: (i % 4) * 15,
      })),
    [hours.startHour, hours.endHour]
  );

  // Cancelled and no-show appointments no longer hold their slot: they are
  // drawn faded behind, and only the rest share the column in lanes.
  const { active, released, lanes, maxLanes } = useMemo(() => {
    const active = appointments.filter((a) => holdsSlot(a.status));
    const released = appointments.filter((a) => !holdsSlot(a.status));
    const lanes = layoutLanes(
      active.map((a) => ({ id: a.id, start: new Date(a.start).getTime(), end: new Date(a.end).getTime() })),
    );
    let maxLanes = 1;
    for (const lane of lanes.values()) maxLanes = Math.max(maxLanes, lane.lanes);
    return { active, released, lanes, maxLanes };
  }, [appointments]);

  const { setNodeRef } = useDroppable({
    id: `professional-column-${professional.id}`,
    data: {
      type: "professional-column",
      professionalId: professional.id,
    },
  });

  return (
    <div
      ref={setNodeRef}
      className="flex-1 border-r last:border-r-0 relative"
      style={{ minWidth: Math.max(COLUMN_MIN_WIDTH, maxLanes * LANE_MIN_WIDTH) }}
    >
      {/* Same 48px as the corner above the hours, so the rows line up. */}
      <div className="sticky top-0 bg-background z-10 h-12 px-3 border-b flex items-center gap-3">
        <Avatar className="h-8 w-8">
          <AvatarImage src={professional.avatarUrl} />
          <AvatarFallback>{professional.name.slice(0, 2)}</AvatarFallback>
        </Avatar>
        <span className="font-medium truncate">{professional.name}</span>
      </div>
      <div className="relative">
        {slots.map((slot, index) => (
          <TimeSlot
            key={index}
            slot={slot}
            professionalId={professional.id}
            index={index}
            date={date}
            onSlotClick={onSlotClick}
          />
        ))}
        {released.map((appointment) => (
          <AppointmentBlock
            key={appointment.id}
            appointment={appointment}
            startHour={hours.startHour}
            ghost
            t={t}
          />
        ))}
        {active.map((appointment) => (
          <AppointmentBlock
            key={appointment.id}
            appointment={appointment}
            startHour={hours.startHour}
            lane={lanes.get(appointment.id)}
            isDragging={draggingId === appointment.id}
            onClick={(appointmentId) => onAppointmentClick?.(appointmentId)}
            onEditClick={(appointmentId) => onEditClick?.(appointmentId)}
            t={t}
          />
        ))}
      </div>
    </div>
  );
};
