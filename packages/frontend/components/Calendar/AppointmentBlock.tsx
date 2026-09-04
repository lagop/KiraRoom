// components/calendar/AppointmentBlock.tsx
import React, { useMemo, useRef } from "react";
import { useDraggable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { Appointment } from "./types";
import { Card } from "@/components/ui/Card";
import { format } from "date-fns";
import { es } from "date-fns/locale";

interface AppointmentBlockProps {
  appointment: Appointment;
  isDragging?: boolean;
  isDragOverlay?: boolean;
  onClick?: (appointmentId: string) => void;
  onEditClick?: (appointmentId: string) => void;
}

const SLOT_HEIGHT = 24; // 15min = 24px
const START_HOUR = 8;
const CARD_WIDTH = 256; // Standard width for appointment cards

export const AppointmentBlock: React.FC<AppointmentBlockProps> = ({
  appointment,
  isDragging,
  isDragOverlay = false,
  onClick,
  onEditClick,
}) => {
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const isRightMouseDown = useRef(false);
  const lastClickTime = useRef<number>(0);
  
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: appointment.id,
    data: {
      type: "appointment",
      appointment,
    },
  });

  const handleMouseDown = (e: React.MouseEvent) => {
    // Only allow drag with right mouse button (button === 2)
    if (e.button === 2) {
      isRightMouseDown.current = true;
      dragStartPos.current = { x: e.clientX, y: e.clientY };
      if (listeners?.onMouseDown) {
        listeners.onMouseDown(e);
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // Only handle right mouse button for drag
    if (e.button === 2 && dragStartPos.current) {
      isRightMouseDown.current = false;
      dragStartPos.current = null;
      if (listeners?.onMouseUp) {
        listeners.onMouseUp(e);
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    // Only allow drag move if right mouse button is down
    if (isRightMouseDown.current && listeners?.onMouseMove) {
      listeners.onMouseMove(e);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    // Only handle left mouse button (button === 0) for click
    if (e.button === 0) {
      // Extract original appointment ID from calendar appointment ID
      // Calendar appointment IDs are in format: `${appointmentId}-${index}` for multi-service
      const originalAppointmentId = appointment.id.includes('-')
        ? appointment.id.substring(0, appointment.id.lastIndexOf('-'))
        : appointment.id;
      
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
    const start = new Date(appointment.start);
    const end = new Date(appointment.end);
    const startMinutes =
      (start.getHours() - START_HOUR) * 60 + start.getMinutes();
    const duration = (end.getTime() - start.getTime()) / 1000 / 60;

    return {
      top: (startMinutes / 15) * SLOT_HEIGHT,
      height: (duration / 15) * SLOT_HEIGHT,
      width: CARD_WIDTH,
      transform: transform
        ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
        : undefined,
      zIndex: isDragging ? 1000 : 1,
    };
  }, [appointment, transform, isDragging]);

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
    const overlayStyle = {
      width: style.width,
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
          {appointment.clientName || "Bloqueado"}
        </div>
        <div className="text-xs opacity-80 truncate">
          {appointment.serviceName}
        </div>
        <div className="text-xs opacity-60 mt-1">
          {format(new Date(appointment.start), "HH:mm", { locale: es })} -{" "}
          {format(new Date(appointment.end), "HH:mm", { locale: es })}</div>
      </Card>
    );
  }

  // Regular grid rendering
  return (
    <Card
      ref={setNodeRef}
      style={style}
      className={cn(
        "absolute left-1 right-1 p-2 cursor-move transition-shadow hover:shadow-lg",
        "mt-[1px] mb-[1px]",
        typeStyles[appointment.type]
      )}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseMove={handleMouseMove}
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
        {appointment.clientName || "Bloqueado"}
      </div>
      <div className="text-xs opacity-80 truncate">
        {appointment.serviceName}
      </div>
      <div className="text-xs opacity-60 mt-1">
        {format(new Date(appointment.start), "HH:mm", { locale: es })} -{" "}
        {format(new Date(appointment.end), "HH:mm", { locale: es })}</div>
    </Card>
  );
};
