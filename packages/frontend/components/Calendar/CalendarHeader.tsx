// components/calendar/CalendarHeader.tsx
import React from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Calendar, LayoutGrid, List } from "lucide-react";
import { Button } from "@/src/components/ui/Button";
import { MonthPicker } from "./MonthPicker";
import { dateOfDay, localDay, shiftDay } from "./day-grid";

interface CalendarHeaderProps {
  /** The day shown, "yyyy-MM-dd". */
  day: string;
  onDayChange: (day: string) => void;
  /**
   * Two layouts share this calendar surface:
   *   - "day":    full grid with professional columns.
   *   - "agenda": mobile-first list grouped by professional.
   * The Agenda view is the default on <md viewports since the grid
   * does not collapse gracefully to phone widths.
   */
  mode?: "day" | "agenda";
  onModeChange?: (mode: "day" | "agenda") => void;
  t: (key: string, params?: Record<string, any>) => string;
}

export const CalendarHeader: React.FC<CalendarHeaderProps> = ({
  day,
  onDayChange,
  mode = "day",
  onModeChange,
  t,
}) => {
  // Days move by the calendar, not by 24 hours: a day with a clock change
  // is 23 or 25 hours long (see day-grid.ts).
  const selectedDate = dateOfDay(day);
  return (
    <div className="flex flex-col gap-3 p-4 border-b bg-card sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="outline"
          size="icon"
          aria-label={t("appointments.calendarView.prevDay")}
          onClick={() => onDayChange(shiftDay(day, -1))}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label={t("appointments.calendarView.nextDay")}
          onClick={() => onDayChange(shiftDay(day, 1))}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <MonthPicker
          selected={selectedDate}
          onSelect={(date) => onDayChange(localDay(date))}
          label={t("appointments.calendarView.pickDay")}
        />
        <div className="ml-0 sm:ml-4">
          <h2 className="text-lg sm:text-2xl font-bold capitalize">
            {format(selectedDate, "EEEE d", { locale: es })}
          </h2>
          <p className="text-xs sm:text-sm text-muted-foreground capitalize">
            {format(selectedDate, "MMMM yyyy", { locale: es })}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {onModeChange && (
          <div className="inline-flex rounded-md border border-input bg-background p-0.5 text-xs">
            <button
              type="button"
              aria-label={t("appointments.calendarView.agendaView")}
              aria-pressed={mode === "agenda"}
              onClick={() => onModeChange("agenda")}
              className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 transition-colors ${
                mode === "agenda"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <List className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("appointments.calendarView.agenda")}</span>
            </button>
            <button
              type="button"
              aria-label={t("appointments.calendarView.gridView")}
              aria-pressed={mode === "day"}
              onClick={() => onModeChange("day")}
              className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 transition-colors ${
                mode === "day"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("appointments.calendarView.day")}</span>
            </button>
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          aria-label={t("appointments.calendarView.today")}
          onClick={() => onDayChange(localDay())}
        >
          <Calendar className="h-4 w-4 sm:mr-2" />
          <span className="hidden sm:inline">{t("appointments.calendarView.today")}</span>
        </Button>
      </div>
    </div>
  );
};
