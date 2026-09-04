// components/calendar/CalendarHeader.tsx
import React from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Calendar, LayoutGrid, List } from "lucide-react";
import { Button } from "@/src/components/ui/Button";
import { MonthPicker } from "./MonthPicker";
import { Professional } from "./types";

interface CalendarHeaderProps {
  selectedDate: Date;
  onDateChange: (date: Date) => void;
  professionals: Professional[];
  /**
   * Two layouts share this calendar surface:
   *   - "day":    full grid with professional columns.
   *   - "agenda": mobile-first list grouped by professional.
   * The Agenda view is the default on <md viewports since the grid
   * does not collapse gracefully to phone widths.
   */
  mode?: "day" | "agenda";
  onModeChange?: (mode: "day" | "agenda") => void;
}

export const CalendarHeader: React.FC<CalendarHeaderProps> = ({
  selectedDate,
  onDateChange,
  professionals,
  mode = "day",
  onModeChange,
}) => {
  return (
    <div className="flex flex-col gap-3 p-4 border-b bg-card sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant="outline"
          size="icon"
          aria-label="Día anterior"
          onClick={() => {
            const newDate = new Date(selectedDate);
            newDate.setDate(newDate.getDate() - 1);
            onDateChange(newDate);
          }}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Día siguiente"
          onClick={() => {
            const newDate = new Date(selectedDate);
            newDate.setDate(newDate.getDate() + 1);
            onDateChange(newDate);
          }}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <MonthPicker selected={selectedDate} onSelect={onDateChange} />
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
              aria-label="Vista agenda"
              aria-pressed={mode === "agenda"}
              onClick={() => onModeChange("agenda")}
              className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 transition-colors ${
                mode === "agenda"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <List className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Agenda</span>
            </button>
            <button
              type="button"
              aria-label="Vista cuadrícula"
              aria-pressed={mode === "day"}
              onClick={() => onModeChange("day")}
              className={`inline-flex items-center gap-1 rounded-sm px-2 py-1 transition-colors ${
                mode === "day"
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Día</span>
            </button>
          </div>
        )}
        <Button variant="outline" size="sm" onClick={() => onDateChange(new Date())}>
          <Calendar className="h-4 w-4 sm:mr-2" />
          <span className="hidden sm:inline">Hoy</span>
        </Button>
      </div>
    </div>
  );
};
