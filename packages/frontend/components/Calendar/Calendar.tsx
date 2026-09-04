// components/calendar/Calendar.tsx
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
import { appointments as mockAppointments } from "./mock";
import { AppointmentBlock } from "./AppointmentBlock";
import { fetchCalendarData, transformToCalendarFormat } from "./calendar.service";
import { useToast } from "@/components/ui/use-toast";
import apiClient from "../../lib/api";
import { SlotClickData } from "./TimeSlot";
import { NewAppointmentPopover } from "./NewAppointmentPopover";
import { EditAppointmentPopover } from "./EditAppointmentPopover";

export const Calendar: React.FC<{
  tenantId?: string;
  date?: Date;
  onDateChange?: (date: Date) => void;
  onAppointmentClick?: (appointmentId: string) => void;
  onAppointmentUpdated?: () => void;
}> = ({
  tenantId = "f6d06ea0-9bd8-490a-a704-e3bf95aad3ce",
  date: externalDate,
  onDateChange: externalOnDateChange,
  onAppointmentClick,
  onAppointmentUpdated
}) => {
  const [internalSelectedDate, setInternalSelectedDate] = useState(new Date('2026-01-06'));
  const selectedDate = externalDate ?? internalSelectedDate;
  const setSelectedDate = useCallback((date: Date) => {
    if (externalOnDateChange) {
      externalOnDateChange(date);
    } else {
      setInternalSelectedDate(date);
    }
  }, [externalOnDateChange]);
  const [appointments, setAppointments] = useState<Appointment[]>(mockAppointments);
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
        await fetchCalendarData(tenantId, selectedDate);
      
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
  }, [tenantId, selectedDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over, delta } = event;
      
      // Visual debug indicator
      console.log('%c=== DRAG END DEBUG ===', 'color: red; font-weight: bold;');
      console.log('Active appointment ID:', active.id);
      console.log('Over object:', over);
      console.log('Delta:', { x: delta.x, y: delta.y });
      
      console.log('Over object:', over);
      console.log('Delta:', { x: delta.x, y: delta.y });

      const activeAppointment = appointments.find((a) => a.id === active.id);
      if (!activeAppointment) {
        console.log('Active appointment not found');
        setActiveId(null);
        return;
      }

      // Extract drop data more robustly
      let overData = over ? (over.data.current as any) : null;
      let newProfessionalId = activeAppointment.professionalId;
      let minutesDelta = Math.round(delta.y / 24) * 15;

      console.log('Over data:', over?.data);
      console.log('Over data current:', over?.data?.current);
      
      if (!overData) {
        console.log('No data in drop target, trying alternative access');
        // Try alternative ways to access the data
        if (over && over.data && typeof over.data === 'object') {
          overData = {...over.data};
        }
      }
      
      if (overData) {
        console.log('Found overData:', overData);
        // Handle different drop target types
        if (overData.professionalId) {
          newProfessionalId = overData.professionalId;
          console.log('Drop on professional column, new professional:', newProfessionalId);
        } else if (overData.slot && overData.professionalId) {
          newProfessionalId = overData.professionalId;
          console.log('Drop on time slot, new professional:', newProfessionalId);
        } else if (over && over.id && typeof over.id === 'string' && over.id.startsWith('professional-column-')) {
          newProfessionalId = (over.id as string).replace('professional-column-', '');
          console.log('Drop on professional column (from ID), new professional:', newProfessionalId);
        } else if (over && over.id && typeof over.id === 'string' && over.id.includes('-')) {
          // Try to extract professionalId from slot ID format: "professionalId-index"
          const parts = (over.id as string).split('-');
          if (parts.length >= 2) {
            newProfessionalId = parts[0];
            console.log('Drop on time slot (from ID), new professional:', newProfessionalId);
          }
        }
      } else {
        console.log('Could not extract data from drop target, using original professional');
      }
      
      // Calculate new time based on delta
      const newStart = new Date(activeAppointment.start);
      newStart.setMinutes(newStart.getMinutes() + minutesDelta);
      
      console.log('Calculated new time:', {
        minutesDelta,
        newStart,
        originalStart: activeAppointment.start
      });

      const duration =
        new Date(activeAppointment.end).getTime() -
        new Date(activeAppointment.start).getTime();
      const newEnd = new Date(newStart.getTime() + duration);

      console.log('New appointment details:', {
        newProfessionalId,
        newStart,
        newEnd,
        minutesDelta
      });

      // Store original appointment for potential revert
      const originalAppointment = {...activeAppointment};

      // Extract original appointment ID from calendar appointment ID
      // Calendar appointment IDs are in format: `${appointmentId}-${index}` for multi-service
      const activeIdStr = String(active.id);
      const originalAppointmentId = activeIdStr.includes('-')
        ? activeIdStr.substring(0, activeIdStr.lastIndexOf('-'))
        : activeIdStr;

      // Check if this is a multi-service appointment (has appointmentServiceId)
      const isMultiService = activeAppointment.appointmentServiceId != null;

      // Optimistic UI update - only update the dragged appointment
      setAppointments((prev) =>
        prev.map((a) => {
          if (a.id === active.id) {
            return {
              ...a,
              professionalId: newProfessionalId,
              start: newStart.toISOString(),
              end: newEnd.toISOString(),
            };
          }
          return a;
        })
      );
      setActiveId(null);

      // Backend API call
      try {
        setIsUpdating(true);

        if (isMultiService) {
          // For multi-service appointments, update the individual service
          console.log('Calling backend update for appointment service:', {
            appointmentServiceId: activeAppointment.appointmentServiceId,
            professionalId: newProfessionalId,
            scheduledStart: newStart.toISOString(),
            scheduledEnd: newEnd.toISOString(),
          });

          await apiClient.updateAppointmentService(activeAppointment.appointmentServiceId as string, {
            professionalId: newProfessionalId,
            scheduledStart: newStart.toISOString(),
            scheduledEnd: newEnd.toISOString(),
          });
        } else {
          // For single service appointments, update the appointment
          console.log('Calling backend update for appointment:', {
            appointmentId: originalAppointmentId,
            professionalId: newProfessionalId,
            scheduledDate: newStart.toISOString().split('T')[0],
            scheduledTime: newStart.toISOString().split('T')[1].substring(0, 5),
          });

          await apiClient.updateAppointment(originalAppointmentId as string, {
            professionalId: newProfessionalId,
            scheduledDate: newStart.toISOString().split('T')[0],
            scheduledTime: newStart.toISOString().split('T')[1].substring(0, 5),
          });
        }

        toast({
          title: 'Appointment updated',
          description: 'The appointment has been successfully rescheduled.',
          variant: 'default',
        });
        
        // Notify parent component about the update
        if (onAppointmentUpdated) {
          onAppointmentUpdated();
        }
      } catch (error) {
        console.error('Failed to update appointment:', error);

        // Revert UI changes on failure
        setAppointments((prev) =>
          prev.map((a) =>
            a.id === active.id ? originalAppointment : a
          )
        );

        toast({
          title: 'Update failed',
          description: 'Failed to update appointment. Please try again.',
          variant: 'destructive',
        });
      } finally {
        setIsUpdating(false);
      }
    },
    [appointments, toast]
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
                  tenantId={tenantId}
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
                  tenantId={tenantId}
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
