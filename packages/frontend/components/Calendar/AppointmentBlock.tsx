// components/calendar/AppointmentBlock.tsx
import React, { useMemo, useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { Appointment } from "./types";
import { Card } from "@/components/ui/Card";
import { salonClock, salonTime } from "./salon-time";
import { useSalonTimeZone } from "./SalonTimeZone";
import { SLOT_HEIGHT, minutesToTop, type Lane } from "./day-grid";

interface AppointmentBlockProps {
  appointment: Appointment;
  /** First hour of the grid it is drawn on. */
  startHour?: number;
  /** Its lane among the overlapping appointments of its column. */
  lane?: Lane;
  /**
   * A cancelled or no-show appointment: drawn faded behind the bookings, and
   * let clicks through to the slot under it, which is free again.
   */
  ghost?: boolean;
  isDragging?: boolean;
  isDragOverlay?: boolean;
  onClick?: (appointmentId: string) => void;
  onEditClick?: (appointmentId: string) => void;
  t: (key: string, params?: Record<string, any>) => string;
}

export const AppointmentBlock: React.FC<AppointmentBlockProps> = ({
  appointment,
  startHour = 8,
  lane = { lane: 0, lanes: 1 },
  ghost = false,
  isDragging,
  isDragOverlay = false,
  onClick,
  onEditClick,
  t,
}) => {
  const timeZone = useSalonTimeZone();
  const lastClickTime = useRef<number>(0);
  
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: appointment.id,
    data: {
      type: "appointment",
      appointment,
    },
    disabled: ghost,
  });

  const handleClick = (e: React.MouseEvent) => {
    // Only handle left mouse button (button === 0) for click
    if (e.button === 0) {
      // The appointment, not the block: block ids of a multi-service visit
      // are "<appointmentId>-<index>", and cutting a plain UUID at its last
      // dash broke the id of every single-service appointment.
      const originalAppointmentId = appointment.appointmentId ?? appointment.id;
      
       // Double-click detection for edit mode
       const now = Date.now();
       if (now - lastClickTime.current < 300) {
         // Double click - trigger edit
         onEditClick?.(originalAppointmentId);
         lastClickTime.current = 0;
       } else {
         // Single click - trigger normal click handler
         lastClickTime.current = now;
         onClick?.(originalAppointmentId);
       }
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    // Prevent context menu on right click
    e.preventDefault();
  };

  const style = useMemo(() => {
    // On the salon's clock: the grid's rows are the salon's hours.
    const start = new Date(appointment.start);
    const end = new Date(appointment.end);
    const duration = (end.getTime() - start.getTime()) / 1000 / 60;
    // Its share of the column: the cards were a fixed 256px, wider than a
    // narrow column and on top of each other when two overlapped.
    const share = 100 / lane.lanes;

    return {
      top: minutesToTop(salonClock(start, timeZone).minutes, startHour),
      height: (duration / 15) * SLOT_HEIGHT,
      left: `calc(${lane.lane * share}% + 2px)`,
      width: `calc(${share}% - 4px)`,
      transform: transform
        ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
        : undefined,
      zIndex: isDragging ? 1000 : ghost ? 0 : 1,
    };
  }, [appointment, transform, isDragging, timeZone, startHour, lane.lane, lane.lanes, ghost]);

  const statusLabel = appointment.status ? t(`appointments.status_${appointment.status}`) : undefined;

  const getStatusStyles = (status?: string) => {
    switch (status) {
      case 'confirmed':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'in_progress':
        return 'bg-blue-100 text-blue-800 border-blue-200';
      case 'completed':
        return 'bg-purple-100 text-purple-800 border-purple-200';
      case 'cancelled':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'no_show':
        return 'bg-gray-100 text-gray-800 border-gray-200';
      default:
        return 'bg-primary text-primary-foreground border-primary/20';
    }
  };

  const typeStyles = {
    appointment: getStatusStyles(appointment.status),
    lunch: "bg-yellow-100 text-yellow-900 border-yellow-300",
    blocked: "bg-gray-100 text-gray-700 border-gray-300",
  };

  // Don't render the original card if it's being dragged (but not in DragOverlay)
  // The dragged version will be rendered in the DragOverlay
  if (isDragging && !isDragOverlay) {
    return null;
  }

  // If this is the DragOverlay version, use Card component with proper styling
  if (isDragOverlay) {
    // For DragOverlay, use the same Card component but with transform positioning
    // The overlay takes the size of the dragged block (dnd-kit measures it).
    const overlayStyle = {
      width: "100%",
      height: style.height,
      transform: transform
        ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
        : undefined,
      zIndex: 1000,
      // Remove absolute positioning for DragOverlay
      position: 'relative' as const,
    };
    
    return (
      <Card
        style={overlayStyle}
        className={cn(
          "p-2 cursor-move transition-shadow hover:shadow-lg",
          typeStyles[appointment.type],
          "shadow-2xl opacity-90",
          "inline-block" // Important for DragOverlay positioning
        )}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <div className="text-xs font-medium truncate">
          {appointment.clientName || t("appointments.calendarView.blocked")}
        </div>
        <div className="text-xs opacity-80 truncate">
          {appointment.serviceName}
        </div>
        <div className="text-xs opacity-60 mt-1">
          {salonTime(appointment.start, timeZone)} -{" "}
          {salonTime(appointment.end, timeZone)}</div>
      </Card>
    );
  }

  if (ghost) {
    return (
      <Card
        style={style}
        aria-hidden
        className={cn(
          "absolute p-2 pointer-events-none overflow-hidden border-dashed shadow-none opacity-60",
          typeStyles[appointment.type],
        )}
      >
        <div className="text-xs font-medium truncate line-through">
          {appointment.clientName || t("appointments.calendarView.blocked")}
        </div>
        <div className="text-xs truncate">{statusLabel}</div>
      </Card>
    );
  }

  // Regular grid rendering
  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "absolute p-2 cursor-move overflow-hidden transition-shadow hover:shadow-lg",
        "mt-[1px] mb-[1px]",
        typeStyles[appointment.type]
      )}
      title={statusLabel}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      {...attributes}
      {...listeners}
    >
      {appointment.isMultiService && (
        <div className="absolute top-1 right-1">
          <svg className="w-4 h-4 text-indigo-600 font-bold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
        </div>
      )}
      <div className="text-xs font-medium truncate">
        {appointment.clientName || t("appointments.calendarView.blocked")}
      </div>
      <div className="text-xs opacity-80 truncate">
        {appointment.serviceName}
      </div>
      <div className="text-xs opacity-60 mt-1">
        {salonTime(appointment.start, timeZone)} -{" "}
        {salonTime(appointment.end, timeZone)}</div>
    </Card>
  );
};
