// components/calendar/TimeSlot.tsx
import React from "react";
import { useDroppable } from "@dnd-kit/core";
import { TimeSlot as TimeSlotType } from "./types";

export interface SlotClickData {
  professionalId: string;
  hour: number;
  minute: number;
  date: Date;
}

interface TimeSlotProps {
  slot: TimeSlotType;
  professionalId: string;
  index: number;
  date: Date;
  onSlotClick?: (data: SlotClickData) => void;
}

export const TimeSlot: React.FC<TimeSlotProps> = ({
  slot,
  professionalId,
  index,
  date,
  onSlotClick,
}) => {
  const { setNodeRef } = useDroppable({
    id: `${professionalId}-${index}`,
    data: {
      type: "slot",
      slot,
      professionalId,
    },
  });

  const handleClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    onSlotClick?.({ professionalId, hour: slot.hour, minute: slot.minute, date });
  };

  return (
    <div
      ref={setNodeRef}
      className="h-6 border-b border-border/30 hover:bg-accent/50 transition-colors cursor-pointer group relative"
      onClick={handleClick}
    >
      <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-xs text-muted-foreground pointer-events-none">
        +
      </span>
    </div>
  );
};
