// components/calendar/ProfessionalColumn.tsx
import React, { useMemo } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useDroppable } from "@dnd-kit/core";
import { Professional, Appointment } from "./types";
import { TimeSlot, SlotClickData } from "./TimeSlot";
import { AppointmentBlock } from "./AppointmentBlock";

interface ProfessionalColumnProps {
  professional: Professional;
  date: Date;
  appointments: Appointment[];
  draggingId?: string | null;
  onAppointmentClick?: (appointmentId: string) => void;
  onSlotClick?: (data: SlotClickData) => void;
  onEditClick?: (appointmentId: string) => void;
}

const START_HOUR = 8;
const END_HOUR = 20;

export const ProfessionalColumn: React.FC<ProfessionalColumnProps> = ({
  professional,
  date,
  appointments,
  draggingId,
  onAppointmentClick,
  onSlotClick,
  onEditClick,
}) => {
  const slots = useMemo(
    () =>
      Array.from({ length: (END_HOUR - START_HOUR) * 4 }, (_, i) => ({
        hour: START_HOUR + Math.floor(i / 4),
        minute: (i % 4) * 15,
      })),
    []
  );

  const { setNodeRef } = useDroppable({
    id: `professional-column-${professional.id}`,
    data: {
      type: "professional-column",
      professionalId: professional.id,
    },
  });

  return (
    <div ref={setNodeRef} className="flex-1 min-w-64 border-r last:border-r-0 relative">
      <div className="sticky top-0 bg-background z-10 p-3 border-b flex items-center gap-3">
        <Avatar className="h-8 w-8">
          <AvatarImage src={professional.avatarUrl} />
          <AvatarFallback>{professional.name.slice(0, 2)}</AvatarFallback>
        </Avatar>
        <span className="font-medium">{professional.name}</span>
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
        {appointments.map((appointment) => (
          <AppointmentBlock
            key={appointment.id}
            appointment={appointment}
            isDragging={draggingId === appointment.id}
            onClick={(appointmentId) => onAppointmentClick?.(appointmentId)}
            onEditClick={(appointmentId) => onEditClick?.(appointmentId)}
          />
        ))}
      </div>
    </div>
  );
};
