// components/calendar/Calendar.tsx
import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useMediaQuery } from "@/lib/use-media-query";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CalendarHeader } from "./CalendarHeader";
import { TimeGrid } from "./TimeGrid";
import { AgendaView } from "./AgendaView";
import { Professional, Appointment } from "./types";
import { AppointmentBlock } from "./AppointmentBlock";
import { fetchCalendarData, fetchSalonTimeZone, transformToCalendarFormat } from "./calendar.service";
import { FALLBACK_SALON_TIMEZONE, salonClock, salonTime } from "./salon-time";
import { SalonTimeZoneProvider } from "./SalonTimeZone";
import { useToast } from "@/components/ui/use-toast";
import apiClient from "../../lib/api";
import { SlotClickData } from "./TimeSlot";
import { DRAG_START, droppedOnProfessional, minutesFromDrag, moveErrorText, planMove, serviceOnlyEffect, type MovePlan, type ServiceOnlyEffect } from "./drag-move";
import { MoveVisitDialog, type MoveScope } from "./MoveVisitDialog";
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
 *
 * Everything is drawn on the salon's clock (Tenant.timezone), whatever zone
 * the browser is in: blocks hold real instants and salon-time.ts turns them
 * into the salon's hours and minutes.
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
  // The salon's zone, asked for once: it does not change from day to day.
  const [timeZone, setTimeZone] = useState(FALLBACK_SALON_TIMEZONE);
  const timeZoneRequest = useRef<Promise<string> | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [debugMode, setDebugMode] = useState(false); // Debug mode for drop zones
  const [newAppointmentSlot, setNewAppointmentSlot] = useState<SlotClickData | null>(null);
  const [editingAppointmentId, setEditingAppointmentId] = useState<string | null>(null);
  // A dropped service of a multi-service visit, waiting for the owner to say
  // whether the whole visit moves or only that service.
  const [pendingVisitMove, setPendingVisitMove] = useState<{
    moving: Appointment;
    plan: Extract<MovePlan, { kind: "move" }>;
    effect: ServiceOnlyEffect;
  } | null>(null);
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
      
      timeZoneRequest.current ??= fetchSalonTimeZone();
      const [salonZone, { appointments: backendAppointments, professionals: backendProfessionals }] =
        await Promise.all([timeZoneRequest.current, fetchCalendarData(selectedDate)]);

      // Transform data to calendar format
      const { appointments: calendarAppointments, professionals: calendarProfessionals } =
        transformToCalendarFormat(backendAppointments, backendProfessionals, salonZone);

      setTimeZone(salonZone);
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

  // A click stays a click; only a real drag (or a long press) moves it.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: DRAG_START.mouse }),
    useSensor(TouchSensor, { activationConstraint: DRAG_START.touch }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  /** Moves one service of a multi-service visit on the server, then redraws the day. */
  const moveVisit = useCallback(
    async (moving: Appointment, plan: Extract<MovePlan, { kind: "move" }>, scope: MoveScope) => {
      try {
        setIsUpdating(true);
        // How far, not where to: the server moves every service of the visit
        // by the same amount and re-reads each on the salon's clock.
        await apiClient.moveAppointmentService(moving.appointmentServiceId as string, {
          scope,
          minutesDelta: Math.round((plan.start.getTime() - new Date(moving.start).getTime()) / 60_000),
          professionalId: plan.professionalId,
        });
        toast({
          title: scope === "visit" ? "Visita movida" : "Servicio movido",
          description: `Ahora a las ${salonTime(plan.start, timeZone)}.`,
        });
        // Every service of the visit may have moved: redraw from the server.
        await fetchData();
        onAppointmentUpdated?.();
      } catch (error) {
        toast({ title: "No se ha movido", description: moveErrorText(error), variant: "destructive" });
      } finally {
        setIsUpdating(false);
      }
    },
    [toast, fetchData, onAppointmentUpdated, timeZone],
  );

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

      // One service of a visit with several: the visit decides (visit-move.ts
      // on the server). Owners and managers choose; a professional moves the
      // whole visit, and only one that is all theirs.
      const visit = moving.appointmentId
        ? appointments.filter((a) => a.appointmentId === moving.appointmentId && a.appointmentServiceId)
        : [];
      if (moving.appointmentServiceId && visit.length > 1) {
        if (getCurrentUser()?.role === "staff") {
          if (visit.some((a) => a.professionalId !== moving.professionalId)) {
            toast({
              title: "No se ha movido",
              description: "Esta cita la comparten varios profesionales: pide a la dueña o al encargado que la mueva.",
              variant: "destructive",
            });
            return;
          }
          await moveVisit(moving, plan, "visit");
          return;
        }
        const minutesDelta = Math.round((plan.start.getTime() - new Date(moving.start).getTime()) / 60_000);
        setPendingVisitMove({ moving, plan, effect: serviceOnlyEffect(visit, moving.id, minutesDelta) });
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
        // The whole appointment. Its id was taken from the block id by
        // cutting at the last dash, which for a plain UUID cut off its last
        // group: every single-service move failed. The appointment keeps a
        // day and time on the salon's clock, so the moved instant is read on
        // that clock (the browser's could be an hour away).
        const at = salonClock(plan.start, timeZone);
        await apiClient.updateAppointment(moving.appointmentId ?? moving.id, {
          professionalId: plan.professionalId,
          scheduledDate: at.day,
          scheduledTime: at.time,
        });
        toast({ title: "Cita movida", description: `Ahora a las ${at.time}.` });
        onAppointmentUpdated?.();
      } catch (error) {
        setAppointments((prev) => prev.map((a) => (a.id === moving.id ? original : a)));
        toast({ title: "No se ha movido", description: moveErrorText(error), variant: "destructive" });
      } finally {
        setIsUpdating(false);
      }
    },
    [appointments, toast, onAppointmentUpdated, moveVisit, timeZone]
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
    <SalonTimeZoneProvider timeZone={timeZone}>
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
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
        {pendingVisitMove && (
          <MoveVisitDialog
            professionalName={professionals.find((p) => p.id === pendingVisitMove.moving.professionalId)?.name ?? "este profesional"}
            serviceName={pendingVisitMove.moving.serviceName}
            when={`a las ${salonTime(pendingVisitMove.plan.start, timeZone)}`}
            serviceOnly={pendingVisitMove.effect}
            onCancel={() => setPendingVisitMove(null)}
            onConfirm={(scope) => {
              const { moving, plan } = pendingVisitMove;
              setPendingVisitMove(null);
              void moveVisit(moving, plan, scope);
            }}
          />
        )}
        <DragOverlay>
          {activeAppointment && (
            <AppointmentBlock appointment={activeAppointment} isDragging isDragOverlay />
          )}
        </DragOverlay>
      </div>
    </DndContext>
    </SalonTimeZoneProvider>
  );
};
