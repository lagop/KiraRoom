// components/calendar/AgendaView.tsx
import React, { useCallback, useMemo } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { Clock, User } from "lucide-react";
import { Appointment, Professional } from "./types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { pickedDay, salonClock, salonTime } from "./salon-time";
import { useSalonTimeZone } from "./SalonTimeZone";
import { holdsSlot } from "./day-grid";

interface AgendaViewProps {
  date: Date;
  professionals: Professional[];
  appointments: Appointment[];
  onAppointmentClick?: (appointmentId: string) => void;
  t: (key: string, params?: Record<string, any>) => string;
}

const STATUS_STYLES: Record<string, string> = {
  confirmed: "bg-green-100 text-green-800",
  pending: "bg-yellow-100 text-yellow-800",
  in_progress: "bg-blue-100 text-blue-800",
  completed: "bg-purple-100 text-purple-800",
  cancelled: "bg-red-100 text-red-800",
  no_show: "bg-gray-100 text-gray-800",
};

/**
 * Mobile-first chronological list of appointments grouped by
 * professional. Each section is collapsible-friendly and gives a
 * read-only vertical timeline that's touch-friendly without scroll
 * horizontal (unlike the day-grid, which assumes a desktop viewport).
 *
 * Appointment IDs in calendar mode can be `${originalId}-${index}`
 * for multi-service splits — the click forwards the block's
 * appointmentId so the parent sees the canonical one.
 *
 * Each appointment shows its status. Cancelled and no-show ones stay in the
 * list, faded and struck through, and are not counted as the day's work.
 */
export const AgendaView: React.FC<AgendaViewProps> = ({
  date,
  professionals,
  appointments,
  onAppointmentClick,
  t,
}) => {
  const timeZone = useSalonTimeZone();
  // The picked day on the salon's calendar, and each block's day on it.
  const day = pickedDay(date);
  const onDay = useCallback(
    (apt: Appointment) => salonClock(apt.start, timeZone).day === day,
    [day, timeZone],
  );

  const professionalMap = useMemo(() => {
    const map = new Map<string, Professional>();
    for (const p of professionals) map.set(p.id, p);
    return map;
  }, [professionals]);

  const groupedByPro = useMemo(() => {
    const groups = new Map<string, Appointment[]>();
    for (const apt of appointments) {
      if (!onDay(apt)) continue;
      const list = groups.get(apt.professionalId) ?? [];
      list.push(apt);
      groups.set(apt.professionalId, list);
    }
    // Empty groups still appear so the user sees who's on staff
    // that day.
    for (const p of professionals) {
      if (!groups.has(p.id)) groups.set(p.id, []);
    }
    // Sort each group's appointments by start time.
    for (const [id, list] of groups) {
      list.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    }
    // Preserve professional order so the agenda mirrors the day grid.
    return professionals
      .filter((p) => groups.has(p.id))
      .map((p) => ({ pro: p, items: groups.get(p.id) ?? [] }));
  }, [appointments, onDay, professionals]);

  const dayIsToday = day === salonClock(Date.now(), timeZone).day;
  const dayLabel = format(date, "EEEE d 'de' MMMM", { locale: es });

  const totalForDay = useMemo(
    () =>
      appointments.filter((a) => onDay(a) && holdsSlot(a.status)).length,
    [appointments, onDay],
  );
  const releasedForDay = useMemo(
    () =>
      appointments.filter((a) => onDay(a) && !holdsSlot(a.status)).length,
    [appointments, onDay],
  );
  const countText = (count: number) =>
    count === 1
      ? t("appointments.calendarView.appointmentCountOne")
      : t("appointments.calendarView.appointmentCountMany", { count });

  return (
    <div className="flex flex-col h-full">
      <div
        className={cn(
          "px-4 py-3 border-b bg-muted/30 text-sm",
          dayIsToday && "bg-indigo-50",
        )}
      >
        <p className="font-medium capitalize text-gray-900">{dayLabel}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {dayIsToday ? t("appointments.calendarView.todayPrefix") : ""}
          {totalForDay === 0
            ? t("appointments.calendarView.noAppointments")
            : countText(totalForDay)}
          {releasedForDay > 0 &&
            ` · ${
              releasedForDay === 1
                ? t("appointments.calendarView.cancelledCountOne")
                : t("appointments.calendarView.cancelledCountMany", { count: releasedForDay })
            }`}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto divide-y">
        {groupedByPro.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {t("appointments.calendarView.noProfessionalsConfigured")}
          </div>
        )}
        {groupedByPro.map(({ pro, items }) => (
          <section key={pro.id} className="py-3 px-4">
            <header className="flex items-center gap-3 mb-2">
              <Avatar className="h-9 w-9 flex-shrink-0">
                <AvatarImage src={pro.avatarUrl} />
                <AvatarFallback>{pro.name.slice(0, 2)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900 truncate">
                  {pro.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {items.length === 0
                    ? t("appointments.calendarView.dayOff")
                    : countText(items.filter((a) => holdsSlot(a.status)).length)}
                </p>
              </div>
            </header>

            {items.length === 0 ? (
              <p className="ml-12 text-xs italic text-muted-foreground">
                {t("appointments.calendarView.noneScheduled")}
              </p>
            ) : (
              <ul className="ml-12 space-y-1.5">
                {items.map((apt) => {
                  const start = salonTime(apt.start, timeZone);
                  const end = salonTime(apt.end, timeZone);
                  // Not cut from the block id: a plain UUID has dashes too.
                  const originalId = apt.appointmentId ?? apt.id;
                  const released = !holdsSlot(apt.status);
                  const statusLabel = apt.status ? t(`appointments.status_${apt.status}`) : null;
                  return (
                    <li key={apt.id}>
                      <button
                        type="button"
                        onClick={() => onAppointmentClick?.(originalId)}
                        className={cn(
                          "w-full text-left flex items-start gap-2 rounded-md border bg-white px-3 py-2 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors",
                          released && "border-dashed opacity-70",
                        )}
                        aria-label={`${t("appointments.calendarView.appointmentAt", {
                          client: apt.clientName ?? t("appointments.calendarView.clientFallback"),
                          time: start,
                        })}${statusLabel ? ` (${statusLabel})` : ""}`}
                      >
                        <Clock className="h-4 w-4 mt-0.5 text-indigo-500 flex-shrink-0" />
                        <span className="text-sm font-medium tabular-nums text-gray-900 w-20 flex-shrink-0">
                          {start}
                        </span>
                        <span className={cn("text-sm text-gray-700 min-w-0 flex-1 truncate", released && "line-through")}>
                          {apt.clientName ?? t("appointments.calendarView.noClient")}
                          {apt.serviceName && (
                            <span className="text-xs text-muted-foreground ml-1">
                              · {apt.serviceName}
                            </span>
                          )}
                        </span>
                        {statusLabel && (
                          <span
                            className={cn(
                              "text-[11px] font-medium rounded-full px-2 py-0.5 flex-shrink-0",
                              STATUS_STYLES[apt.status ?? ""] ?? "bg-gray-100 text-gray-800",
                            )}
                          >
                            {statusLabel}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground flex-shrink-0">
                          {start}–{end}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
        {/* Empty-day fallback when the salon has no appointments
            AND no professionals on staff — keeps the page from looking
            like a bug. */}
        {totalForDay === 0 && releasedForDay === 0 && groupedByPro.length > 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <User className="h-6 w-6 opacity-40" />
            <span>{t("appointments.calendarView.noAppointmentsThisDay")}</span>
          </div>
        )}
      </div>
    </div>
  );
};