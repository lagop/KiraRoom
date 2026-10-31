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
import { fetchCalendarData, fetchSalonSettings, transformToCalendarFormat, type SalonSettings } from "./calendar.service";
import { FALLBACK_SALON_TIMEZONE, salonClock, salonTime } from "./salon-time";
import { dateOfDay, gridHours, holdsSlot, initialScrollMinutes, localDay, minutesToTop, salonClosureOn, visibleProfessionals } from "./day-grid";
import type { TimeOff } from "@/lib/time-off";
import { SalonTimeZoneProvider } from "./SalonTimeZone";
import { useToast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";
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
 *
 * The day travels as "yyyy-MM-dd", not as a Date: the page handed a new Date
 * on every render, the fetch depended on it, and every re-render of the page
 * refetched the day (spinner, scroll back to the top, open popovers reset).
 */
export const Calendar: React.FC<{
  /** The day shown, "yyyy-MM-dd" (today when empty). */
  day?: string;
  onDayChange?: (day: string) => void;
  onAppointmentClick?: (appointmentId: string) => void;
  onAppointmentUpdated?: () => void;
}> = ({
  day: externalDay,
  onDayChange: externalOnDayChange,
  onAppointmentClick,
  onAppointmentUpdated
}) => {
  const t = useTranslations();
  const [internalDay, setInternalDay] = useState(() => localDay());
  const day = externalDay || internalDay;
  const selectedDate = useMemo(() => dateOfDay(day), [day]);
  const setDay = useCallback((next: string) => {
    if (externalOnDayChange) {
      externalOnDayChange(next);
    } else {
      setInternalDay(next);
    }
  }, [externalOnDayChange]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  // Time off and closures of the day, shaded in the columns.
  const [timeOff, setTimeOff] = useState<TimeOff[]>([]);
  // The salon's zone and hours, asked for once: they do not change from day to day.
  const [timeZone, setTimeZone] = useState(FALLBACK_SALON_TIMEZONE);
  const [openingHours, setOpeningHours] = useState<SalonSettings["openingHours"]>(null);
  const settingsRequest = useRef<Promise<SalonSettings> | null>(null);
  // Each load takes a number; the answer to an older one (a slower request
  // for the day before) is dropped instead of drawing over the newer day.
  const requestSeq = useRef(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // The day grid's scroll box, and the day and layout it was last placed for.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
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

  /**
   * Loads `forDay`. A new day shows the spinner; a refresh after a change
   * (`quiet`) redraws in place, keeping the scroll and any open popover.
   */
  const load = useCallback(async (forDay: string, quiet: boolean) => {
    const request = ++requestSeq.current;
    if (!quiet) {
      setLoading(true);
      setError(false);
    }
    try {
      settingsRequest.current ??= fetchSalonSettings();
      const [settings, { appointments: backendAppointments, professionals: backendProfessionals }, dayTimeOff] =
        await Promise.all([
          settingsRequest.current,
          fetchCalendarData(forDay),
          // Only shading: a failure here must not take the day's appointments with it.
          apiClient.getTimeOff(forDay, forDay).catch((err) => {
            console.error("Failed to fetch time off:", err);
            return [] as TimeOff[];
          }),
        ]);
      if (request !== requestSeq.current) return;

      // Transform data to calendar format
      const { appointments: calendarAppointments, professionals: calendarProfessionals } =
        transformToCalendarFormat(backendAppointments, backendProfessionals, settings.timeZone);

      setTimeZone(settings.timeZone);
      setOpeningHours(settings.openingHours);
      setAppointments(calendarAppointments);
      setProfessionals(calendarProfessionals);
      setTimeOff(dayTimeOff);
      setError(false);
    } catch (err) {
      if (request !== requestSeq.current) return;
      console.error('Failed to fetch calendar data:', err);
      // A failed refresh keeps what is drawn; a failed day says so.
      if (!quiet) {
        setError(true);
        // No fallback to mock data
        setAppointments([]);
        setProfessionals([]);
        setTimeOff([]);
      }
    } finally {
      if (request === requestSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(day, false);
  }, [load, day]);

  // Nothing that answers after the calendar is gone is drawn.
  useEffect(() => () => {
    requestSeq.current++;
  }, []);

  const fetchData = useCallback(() => load(day, true), [load, day]);

  // Only the professionals who work here (an inactive one only while they
  // still have appointments that day), over the hours they and the salon open.
  const columns = useMemo(
    () => visibleProfessionals(professionals, appointments),
    [professionals, appointments],
  );
  const hours = useMemo(
    () =>
      gridHours({
        day,
        openingHours,
        workingHours: columns.map((p) => p.workingHours ?? []),
        appointments: appointments
          .filter((a) => salonClock(a.start, timeZone).day === day)
          .map((a) => {
            const start = salonClock(a.start, timeZone).minutes;
            return { start, end: start + (new Date(a.end).getTime() - new Date(a.start).getTime()) / 60_000 };
          }),
      }),
    [day, openingHours, columns, appointments, timeZone],
  );

  // The grid opens on the part of the day that matters: around now on today,
  // the first booking on another day. Once per day and layout, not on every
  // refresh.
  useEffect(() => {
    if (loading || error || mode !== "day") return;
    const el = scrollRef.current;
    const key = `${day}|${mode}`;
    if (!el || scrolledFor.current === key) return;
    scrolledFor.current = key;
    const now = salonClock(Date.now(), timeZone);
    const starts = appointments
      .filter((a) => holdsSlot(a.status) && salonClock(a.start, timeZone).day === day)
      .map((a) => salonClock(a.start, timeZone).minutes);
    const target = initialScrollMinutes({
      isToday: now.day === day,
      nowMinutes: now.minutes,
      firstAppointment: starts.length > 0 ? Math.min(...starts) : undefined,
      startHour: hours.startHour,
    });
    el.scrollTop = minutesToTop(target, hours.startHour);
  }, [loading, error, mode, day, appointments, timeZone, hours.startHour]);

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
          title: t(scope === "visit" ? "appointments.calendarView.visitMoved" : "appointments.calendarView.serviceMoved"),
          description: t("appointments.calendarView.movedTo", { time: salonTime(plan.start, timeZone) }),
        });
        // Every service of the visit may have moved: redraw from the server.
        await fetchData();
        onAppointmentUpdated?.();
      } catch (error) {
        toast({ title: t("appointments.calendarView.notMoved"), description: moveErrorText(error), variant: "destructive" });
      } finally {
        setIsUpdating(false);
      }
    },
    // t is a new function on every render, and only reads the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        toast({ title: t("appointments.calendarView.notMoved"), description: plan.message, variant: "destructive" });
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
              title: t("appointments.calendarView.notMoved"),
              description: t("appointments.calendarView.sharedVisit"),
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
        toast({
          title: t("appointments.calendarView.appointmentMoved"),
          description: t("appointments.calendarView.movedTo", { time: at.time }),
        });
        onAppointmentUpdated?.();
      } catch (error) {
        setAppointments((prev) => prev.map((a) => (a.id === moving.id ? original : a)));
        toast({ title: t("appointments.calendarView.notMoved"), description: moveErrorText(error), variant: "destructive" });
      } finally {
        setIsUpdating(false);
      }
    },
    // t is a new function on every render, and only reads the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // The whole salon closed today: said above the grid and the agenda alike.
  const closure = useMemo(() => salonClosureOn(day, timeOff), [day, timeOff]);

  const activeAppointment = useMemo(
    () => appointments.find((a) => a.id === activeId),
    [appointments, activeId]
  );

  return (
    <SalonTimeZoneProvider timeZone={timeZone}>
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex flex-col h-full min-w-0 bg-background">
        <CalendarHeader
          day={day}
          onDayChange={setDay}
          mode={mode}
          onModeChange={handleModeChange}
          t={t}
        />
        <div className="relative flex-1 min-h-0 min-w-0 flex flex-col">
          {!loading && !error && closure && (
            <div
              role="status"
              data-test="salon-closed"
              className="px-4 py-2 text-sm bg-amber-50 text-amber-900 border-b border-amber-200"
            >
              {closure.note?.trim() ? `Salón cerrado — ${closure.note.trim()}` : "Salón cerrado"}. No se ofrecen citas
              online ni por la recepcionista.
            </div>
          )}
          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
              <span className="ml-3">{t("appointments.calendarView.loading")}</span>
            </div>
          ) : error ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-red-500">
              {t("appointments.calendarView.loadError")}
              <button
                type="button"
                onClick={() => void load(day, false)}
                className="px-3 py-1.5 text-sm border border-border rounded-md text-foreground hover:bg-accent transition-colors"
              >
                {t("appointments.calendarView.retry")}
              </button>
            </div>
          ) : mode === "agenda" ? (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <AgendaView
                date={selectedDate}
                professionals={columns}
                appointments={appointments}
                onAppointmentClick={onAppointmentClick}
                t={t}
              />
            </div>
          ) : (
            // The grid's one scroll box, both ways: the day is taller than
            // the calendar (it was clipped around 15:00, with no way down)
            // and wider with many professionals. The hours and the
            // professionals' names stick to its edges.
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 min-w-0 overflow-auto overscroll-contain"
              data-test="calendar-scroll"
            >
              <TimeGrid
                date={selectedDate}
                hours={hours}
                professionals={columns}
                appointments={appointments}
                timeOff={timeOff}
                draggingId={activeId}
                onAppointmentClick={onAppointmentClick}
                onSlotClick={handleSlotClick}
                onEditClick={handleEditClick}
                t={t}
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
                void fetchData();
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
                void fetchData();
                onAppointmentUpdated?.();
              }}
            />
          )}
          {isUpdating && (
            <div className="absolute inset-0 bg-black bg-opacity-10 flex items-center justify-center">
              <div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full"></div>
              <span className="ml-2 text-sm text-indigo-600">{t("appointments.calendarView.updating")}</span>
            </div>
          )}
        </div>
        {pendingVisitMove && (
          <MoveVisitDialog
            professionalName={
              professionals.find((p) => p.id === pendingVisitMove.moving.professionalId)?.name ??
              t("appointments.calendarView.thisProfessional")
            }
            serviceName={pendingVisitMove.moving.serviceName}
            when={t("appointments.calendarView.atTime", { time: salonTime(pendingVisitMove.plan.start, timeZone) })}
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
            <AppointmentBlock
              appointment={activeAppointment}
              startHour={hours.startHour}
              isDragging
              isDragOverlay
              t={t}
            />
          )}
        </DragOverlay>
      </div>
    </DndContext>
    </SalonTimeZoneProvider>
  );
};
