// components/calendar/AgendaView.tsx
import React, { useMemo } from "react";
import { format, isToday, isSameDay } from "date-fns";
import { es } from "date-fns/locale";
import { Clock, User } from "lucide-react";
import { Appointment, Professional } from "./types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

interface AgendaViewProps {
  date: Date;
  professionals: Professional[];
  appointments: Appointment[];
  onAppointmentClick?: (appointmentId: string) => void;
}

/**
 * Mobile-first chronological list of appointments grouped by
 * professional. Each section is collapsible-friendly and gives a
 * read-only vertical timeline that's touch-friendly without scroll
 * horizontal (unlike the day-grid, which assumes a desktop viewport).
 *
 * Appointment IDs in calendar mode can be `${originalId}-${index}`
 * for multi-service splits — strip the suffix when forwarding the
 * click up so the parent sees the canonical appointmentId.
 */
export const AgendaView: React.FC<AgendaViewProps> = ({
  date,
  professionals,
  appointments,
  onAppointmentClick,
}) => {
  const professionalMap = useMemo(() => {
    const map = new Map<string, Professional>();
    for (const p of professionals) map.set(p.id, p);
    return map;
  }, [professionals]);

  const groupedByPro = useMemo(() => {
    const groups = new Map<string, Appointment[]>();
    for (const apt of appointments) {
      if (!isSameDay(new Date(apt.start), date)) continue;
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
  }, [appointments, date, professionals]);

  const dayIsToday = isToday(date);
  const dayLabel = format(date, "EEEE d 'de' MMMM", { locale: es });

  const totalForDay = useMemo(
    () =>
      appointments.filter((a) => isSameDay(new Date(a.start), date)).length,
    [appointments, date],
  );

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
          {dayIsToday ? "Hoy · " : ""}
          {totalForDay === 0
            ? "sin citas"
            : `${totalForDay} cita${totalForDay === 1 ? "" : "s"}`}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto divide-y">
        {groupedByPro.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Sin profesionales configurados
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
                    ? "Día libre"
                    : `${items.length} cita${items.length === 1 ? "" : "s"}`}
                </p>
              </div>
            </header>

            {items.length === 0 ? (
              <p className="ml-12 text-xs italic text-muted-foreground">
                Sin citas programadas
              </p>
            ) : (
              <ul className="ml-12 space-y-1.5">
                {items.map((apt) => {
                  const start = new Date(apt.start);
                  const end = new Date(apt.end);
                  const originalId = apt.id.includes("-")
                    ? apt.id.substring(0, apt.id.lastIndexOf("-"))
                    : apt.id;
                  return (
                    <li key={apt.id}>
                      <button
                        type="button"
                        onClick={() => onAppointmentClick?.(originalId)}
                        className="w-full text-left flex items-start gap-2 rounded-md border bg-white px-3 py-2 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
                        aria-label={`Cita de ${apt.clientName ?? "cliente"} a las ${format(start, "HH:mm")}`}
                      >
                        <Clock className="h-4 w-4 mt-0.5 text-indigo-500 flex-shrink-0" />
                        <span className="text-sm font-medium tabular-nums text-gray-900 w-20 flex-shrink-0">
                          {format(start, "HH:mm")}
                        </span>
                        <span className="text-sm text-gray-700 min-w-0 flex-1 truncate">
                          {apt.clientName ?? "(sin cliente)"}
                          {apt.serviceName && (
                            <span className="text-xs text-muted-foreground ml-1">
                              · {apt.serviceName}
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground flex-shrink-0">
                          {format(start, "HH:mm")}–{format(end, "HH:mm")}
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
        {totalForDay === 0 && groupedByPro.length > 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <User className="h-6 w-6 opacity-40" />
            <span>No hay citas para este día</span>
          </div>
        )}
      </div>
    </div>
  );
};