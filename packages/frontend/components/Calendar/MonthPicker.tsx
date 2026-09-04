// components/calendar/MonthPicker.tsx
import React from "react";
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
}

export const MonthPicker: React.FC<MonthPickerProps> = ({
  selected,
  onSelect,
}) => {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="justify-start text-left font-normal"
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {format(selected, "MMM yyyy", { locale: es })}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        {(Calendar as any)({
          selected: selected,
          onSelect: (date: Date | null) => date && onSelect(date),
          initialFocus: true,
        })}
      </PopoverContent>
    </Popover>
  );
};
