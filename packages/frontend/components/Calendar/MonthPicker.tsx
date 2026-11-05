// components/calendar/MonthPicker.tsx
import React, { useState } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/src/components/ui/Button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface MonthPickerProps {
  selected: Date;
  onSelect: (date: Date) => void;
  label?: string;
}

/**
 * Picks the calendar's day. The DayPicker had no `mode`, so it selected
 * nothing and choosing a day did not change the date; it also spoke English
 * and started the week on Sunday. It picks a single day now, in Spanish, weeks
 * from Monday, and closes once it has.
 */
export const MonthPicker: React.FC<MonthPickerProps> = ({
  selected,
  onSelect,
  label,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="justify-start text-left font-normal capitalize"
          aria-label={label}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {format(selected, "MMM yyyy", { locale: es })}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        <Calendar
          mode="single"
          selected={selected}
          defaultMonth={selected}
          onSelect={(date?: Date) => {
            // Clicking the selected day again "unselects" it: stay on it.
            if (date) onSelect(date);
            setOpen(false);
          }}
          locale={es}
          weekStartsOn={1}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
};
