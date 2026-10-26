// components/calendar/Calendar.tsx
import { format } from "date-fns";
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useMediaQuery } from "@/lib/use-media-query";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
} from "@dnd-kit/core";
import { CalendarHeader } from "./CalendarHeader";
import { TimeGrid } from "./TimeGrid";
import { AgendaView } from "./AgendaView";
import { Professional, Appointment } from "./types";
import { AppointmentBlock } from "./AppointmentBlock";
import { fetchCalendarData, transformToCalendarFormat } from "./calendar.service";
import { useToast } from "@/components/ui/use-toast";
import apiClient from "../../lib/api";
import { SlotClickData } from "./TimeSlot";
import { droppedOnProfessional, minutesFromDrag, moveErrorText, planMove } from "./drag-move";
import { getCurrentUser } from "@/lib/utils";
import { NewAppointmentPopover } from "./NewAppointmentPopover";
import { EditAppointmentPopover } from "./EditAppointmentPopover";

/**
 * The day view of the dashboard's appointments.
 *
 * The salon comes from the caller's token. This used to default to one
 * hardcoded salon's UUID (and the appointments page passed the same one), so
 * the calendar loaded for that salon only and answered "Failed to load
 * calendar data" for every other; it also opened on 2026-01-06 with mock
 * appointments until the fetch returned.
 */
export const Calendar: React.FC<{
  date?: Date;
  onDateChange?: (date: Date) => void;
  onAppointmentClick?: (appointmentId: string) => void;
  onAppointmentUpdated?: () => void;
}> = ({
  date: externalDate,
  onDateChange: externalOnDateChange,
  onAppointmentClick,
  onAppointmentUpdated
}) => {
  const [internalSelectedDate, setInternalSelectedDate] = useState(() => new Date());
  const selectedDate = externalDate ?? internalSelectedDate;
  const setSelectedDate = useCallback((date: Date) => {
    if (externalOnDateChange) {
      externalOnDateChange(date);
    } else {
      setInternalSelectedDate(date);
    }
  }, [externalOnDateChange]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [debugMode, setDebugMode] = useState(false); // Debug mode for drop zones
  const [newAppointmentSlot, setNewAppointmentSlot] = useState<SlotClickData | null>(null);
  const [editingAppointmentId, setEditingAppointmentId] = useState<string | null>(null);
  // Mobile-first calendar: prefer the chronological list (agenda) on
  // phones, the multi-column day grid on tablets/desktops. Falls back
  // to agenda during SSR (window undefined) so the initial markup
  // matches mobile.
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [mode, setMode] = useState<"day" | "agenda">(
    typeof window === "undefined" ? "agenda" : "day",
  );
  // Keep mode in sync with viewport — when the user resizes to mobile
  // we auto-pick the friendlier layout, but only if they haven't
  // explicitly chosen one.
  const [modeTouched, setModeTouched] = useState(false);
  useEffect(() => {
    if (modeTouched) return;
    setMode(isDesktop ? "day" : "agenda");
  }, [isDesktop, modeTouched]);
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Fetch real data from backend
      const { appointments: backendAppointments, professionals: backendProfessionals } =
        await fetchCalendarData(selectedDate);
      
      // Transform data to calendar format
      const { appointments: calendarAppointments, professionals: calendarProfessionals } =
        transformToCalendarFormat(backendAppointments, backendProfessionals);
      
      setAppointments(calendarAppointments);
      setProfessionals(calendarProfessionals);
      
    } catch (err) {
      console.error('Failed to fetch calendar data:', err);
      setError('Failed to load calendar data.');
      // No fallback to mock data
      setAppointments([]);
      setProfessionals([]);
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over, delta } = event;
      setActiveId(null);

      const moving = appointments.find((a) => a.id === active.id);
      if (!moving) return;

      const plan = planMove({
        start: moving.start,
        end: moving.end,
        professionalId: moving.professionalId,
        newProfessionalId: droppedOnProfessional(over as any, moving.professionalId),
        minutesDelta: minutesFromDrag(delta.y),
        isStaff: getCurrentUser()?.role === "staff",
      });
      if (plan.kind === "none") return;
      if (plan.kind === "refuse") {
        toast({ title: "No se ha movido", description: plan.message, variant: "destructive" });
        return;
      }

      // Optimistic: the block moves now and comes back if the server refuses.
      const original = { ...moving };
      setAppointments((prev) =>
        prev.map((a) =>
          a.id === moving.id
            ? { ...a, professionalId: plan.professionalId, start: plan.start.toISOString(), end: plan.end.toISOString() }
            : a,
        ),
      );

      try {
        setIsUpdating(true);
        if (moving.appointmentServiceId) {
          // One service of a multi-service appointment.
          await apiClient.updateAppointmentService(moving.appointmentServiceId, {
            professionalId: plan.professionalId,
            scheduledStart: plan.start.toISOString(),
            scheduledEnd: plan.end.toISOString(),
          });
        } else {
          // The whole appointment. Its id was taken from the block id by
          // cutting at the last dash, which for a plain UUID cut off its last
          // group: every single-service move failed. The wall clock the
          // calendar shows is what is saved (toISOString() would send UTC).
          await apiClient.updateAppointment(moving.appointmentId ?? moving.id, {
            professionalId: plan.professionalId,
            scheduledDate: format(plan.start, "yyyy-MM-dd"),
            scheduledTime: format(plan.start, "HH:mm"),
          });
        }
        toast({ title: "Cita movida", description: `Ahora a las ${format(plan.start, "HH:mm")}.` });
        onAppointmentUpdated?.();
      } catch (error) {
        setAppointments((prev) => prev.map((a) => (a.id === moving.id ? original : a)));
        toast({ title: "No se ha movido", description: moveErrorText(error), variant: "destructive" });
      } finally {
        setIsUpdating(false);
      }
    },
    [appointments, toast, onAppointmentUpdated]
  );

  const handleSlotClick = useCallback((data: SlotClickData) => {
    setNewAppointmentSlot(data);
  }, []);

  const handleModeChange = useCallback((next: "day" | "agenda") => {
    setMode(next);
    setModeTouched(true);
  }, []);

  const handleEditClick = useCallback((appointmentId: string) => {
    setEditingAppointmentId(appointmentId);
  }, []);

  const activeAppointment = useMemo(
    () => appointments.find((a) => a.id === activeId),
    [appointments, activeId]
  );

  return (
    <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex flex-col h-full min-w-0 bg-background">
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
            <span className="ml-3">Loading calendar data...</span>
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center text-red-500">
            {error}
          </div>
        ) : (
          <>
            <CalendarHeader
              selectedDate={selectedDate}
              onDateChange={setSelectedDate}
              professionals={professionals}
              mode={mode}
              onModeChange={handleModeChange}
            />
            <div className="flex-1 min-h-0 min-w-0 overflow-y-auto relative">
              {mode === "agenda" ? (
                <AgendaView
                  date={selectedDate}
                  professionals={professionals}
                  appointments={appointments}
                  onAppointmentClick={onAppointmentClick}
                />
              ) : (
                <div className="h-full min-w-0 overflow-x-auto overflow-y-hidden">
                  <TimeGrid
                    date={selectedDate}
                    professionals={professionals}
                    appointments={appointments}
                    draggingId={activeId}
                    onAppointmentClick={onAppointmentClick}
                    onSlotClick={handleSlotClick}
                    onEditClick={handleEditClick}
                  />
                </div>
              )}
              {newAppointmentSlot && (
                <NewAppointmentPopover
                  slot={newAppointmentSlot}
                  professionals={professionals}
                  onClose={() => setNewAppointmentSlot(null)}
                  onSuccess={() => {
                    setNewAppointmentSlot(null);
                    fetchData();
                    onAppointmentUpdated?.();
                  }}
                />
              )}
              {editingAppointmentId && (
                <EditAppointmentPopover
                  appointmentId={editingAppointmentId}
                  professionals={professionals}
                  onClose={() => setEditingAppointmentId(null)}
                  onSuccess={() => {
                    setEditingAppointmentId(null);
                    fetchData();
                    onAppointmentUpdated?.();
                  }}
                />
              )}
              {isUpdating && (
                <div className="absolute inset-0 bg-black bg-opacity-10 flex items-center justify-center">
                  <div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full"></div>
                  <span className="ml-2 text-sm text-indigo-600">Updating appointment...</span>
                </div>
              )}
            </div>
          </>
        )}
        <DragOverlay>
          {activeAppointment && (
            <AppointmentBlock appointment={activeAppointment} isDragging isDragOverlay />
          )}
        </DragOverlay>
      </div>
    </DndContext>
  );
};
