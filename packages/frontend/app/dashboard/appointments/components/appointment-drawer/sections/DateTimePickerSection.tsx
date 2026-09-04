import React from "react";
import { Clock } from "lucide-react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";
import type { DateTimePreference } from "../hooks/useAppointmentFormState";

/**
 * Step 3 of the create-mode form: date/time preference.
 *
 * Verbatim move from `appointment-drawer.tsx:748-1105`. Five radio
 * choices drive the suggestion engine:
 *
 *   - `next_available`  → "Next time slot available"
 *   - `today_morning`   → "Hoy por la mañana"
 *   - `today_afternoon` → "Hoy por la tarde"
 *   - `flexible`         → "Flexible timing" + Morning/Afternoon sub-checkboxes
 *   - `specific`         → DayPicker + Morning/Evening/Hour cards
 *
 * Each non-`specific` choice resets `specificDate` / `specificTime` /
 * `specificTimePeriod` to empty. Each non-flexible choice clears
 * `morningPreferred` / `afternoonPreferred`. The `newAppointment.date`
 * is also re-pinned to today for the non-`specific` paths (the
 * original behavior — the suggestion engine uses the appointment
 * date to scope the availability query).
 *
 * Local UI state: the section owns the `view` toggle (hours vs.
 * morning/evening cards) is NOT needed here — the original uses a
 * single combined grid. Kept that way to preserve the exact render
 * tree.
 */

export interface DateTimePickerSectionProps {
  dateTimePreference: DateTimePreference;
  setDateTimePreference: React.Dispatch<
    React.SetStateAction<DateTimePreference>
  >;
  /** When set, the appointment date is reset to today. */
  newAppointmentDate: string;
  setNewAppointmentDate: (date: string) => void;
  hasServices: boolean;
  labels: {
    dateTimePreferences: string;
    selectATimePreference: string;
    pleaseSelectDateTime: string;
    nextTimeSlotAvailable: string;
    todayMorning: string;
    todayAfternoon: string;
    flexibleTimingPreferences: string;
    morningPreferred: string;
    afternoonPreferred: string;
    specificDateAndTime: string;
    selectDate: string;
    selectTimePeriod: string;
    morningAnyHour: string;
    eveningAnyHour: string;
  };
}

export function DateTimePickerSection({
  dateTimePreference,
  setDateTimePreference,
  newAppointmentDate,
  setNewAppointmentDate,
  hasServices,
  labels,
}: DateTimePickerSectionProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center">
        <Clock className="w-5 h-5 mr-2 text-indigo-600" />
        {labels.dateTimePreferences}
      </h3>

      {/* Selection guidance */}
      {hasServices && (
        <>
          {!dateTimePreference.type && (
            <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-center text-blue-700">
                <Clock className="w-5 h-5 mr-2" />
                <span className="text-sm">
                  {labels.selectATimePreference}
                </span>
              </div>
            </div>
          )}

          {dateTimePreference.type === "specific" &&
            (!dateTimePreference.specificDate ||
              !dateTimePreference.specificTimePeriod) && (
              <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-center text-amber-700">
                  <Clock className="w-5 h-5 mr-2" />
                  <span className="text-sm">
                    {labels.pleaseSelectDateTime}
                  </span>
                </div>
              </div>
            )}
        </>
      )}

      {/* Preference options */}
      <div className="space-y-4">
        {/* Next available */}
        <label className="flex items-center">
          <input
            type="radio"
            name="dateTimePreference"
            value="next_available"
            checked={dateTimePreference.type === "next_available"}
            onChange={() => {
              setDateTimePreference({
                ...dateTimePreference,
                type: "next_available",
                morningPreferred: false,
                afternoonPreferred: false,
                specificDate: "",
                specificTime: "",
                specificTimePeriod: "",
              });
              setNewAppointmentDate(new Date().toISOString().split("T")[0]);
            }}
            className="w-4 h-4 text-indigo-600 border-gray-300 focus:ring-indigo-500"
          />
          <span className="ml-3 text-gray-700">
            {labels.nextTimeSlotAvailable}
          </span>
        </label>

        {/* Today morning */}
        <label className="flex items-center">
          <input
            type="radio"
            name="dateTimePreference"
            value="today_morning"
            checked={dateTimePreference.type === "today_morning"}
            onChange={() => {
              setDateTimePreference({
                ...dateTimePreference,
                type: "today_morning",
                morningPreferred: false,
                afternoonPreferred: false,
                specificDate: "",
                specificTime: "",
                specificTimePeriod: "",
              });
              setNewAppointmentDate(new Date().toISOString().split("T")[0]);
            }}
            className="w-4 h-4 text-indigo-600 border-gray-300 focus:ring-indigo-500"
          />
          <span className="ml-3 text-gray-700">{labels.todayMorning}</span>
        </label>

        {/* Today afternoon */}
        <label className="flex items-center">
          <input
            type="radio"
            name="dateTimePreference"
            value="today_afternoon"
            checked={dateTimePreference.type === "today_afternoon"}
            onChange={() => {
              setDateTimePreference({
                ...dateTimePreference,
                type: "today_afternoon",
                morningPreferred: false,
                afternoonPreferred: false,
                specificDate: "",
                specificTime: "",
                specificTimePeriod: "",
              });
              setNewAppointmentDate(new Date().toISOString().split("T")[0]);
            }}
            className="w-4 h-4 text-indigo-600 border-gray-300 focus:ring-indigo-500"
          />
          <span className="ml-3 text-gray-700">{labels.todayAfternoon}</span>
        </label>

        {/* Flexible */}
        <label className="flex items-center">
          <input
            type="radio"
            name="dateTimePreference"
            value="flexible"
            checked={dateTimePreference.type === "flexible"}
            onChange={() => {
              setDateTimePreference({
                ...dateTimePreference,
                type: "flexible",
                specificDate: "",
                specificTime: "",
                specificTimePeriod: "",
              });
              setNewAppointmentDate(new Date().toISOString().split("T")[0]);
            }}
            className="w-4 h-4 text-indigo-600 border-gray-300 focus:ring-indigo-500"
          />
          <span className="ml-3 text-gray-700">
            {labels.flexibleTimingPreferences}
          </span>
        </label>

        {/* Flexible sub-checkboxes */}
        {dateTimePreference.type === "flexible" && (
          <div className="ml-7 space-y-2">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={dateTimePreference.morningPreferred}
                onChange={(e) =>
                  setDateTimePreference({
                    ...dateTimePreference,
                    morningPreferred: e.target.checked,
                  })
                }
                className="w-4 h-4 text-indigo-600 border-gray-300 focus:ring-indigo-500"
              />
              <span className="ml-3 text-gray-700">
                {labels.morningPreferred}
              </span>
            </label>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={dateTimePreference.afternoonPreferred}
                onChange={(e) =>
                  setDateTimePreference({
                    ...dateTimePreference,
                    afternoonPreferred: e.target.checked,
                  })
                }
                className="w-4 h-4 text-indigo-600 border-gray-300 focus:ring-indigo-500"
              />
              <span className="ml-3 text-gray-700">
                {labels.afternoonPreferred}
              </span>
            </label>
          </div>
        )}

        {/* Specific */}
        <label className="flex items-center">
          <input
            type="radio"
            name="dateTimePreference"
            value="specific"
            checked={dateTimePreference.type === "specific"}
            onChange={() =>
              setDateTimePreference({
                ...dateTimePreference,
                type: "specific",
                morningPreferred: false,
                afternoonPreferred: false,
              })
            }
            className="w-4 h-4 text-indigo-600 border-gray-300 focus:ring-indigo-500"
          />
          <span className="ml-3 text-gray-700">
            {labels.specificDateAndTime}
          </span>
        </label>

        {/* Specific date + time period */}
        {dateTimePreference.type === "specific" && (
          <div className="ml-7">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Date selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {labels.selectDate}
                </label>
                <div className="w-full">
                  <DayPicker
                    mode="single"
                    selected={
                      dateTimePreference.specificDate
                        ? new Date(dateTimePreference.specificDate)
                        : undefined
                    }
                    onSelect={(day) => {
                      if (day) {
                        // Use local date components to avoid timezone issues
                        const year = day.getFullYear();
                        const month = String(day.getMonth() + 1).padStart(2, "0");
                        const dayOfMonth = String(day.getDate()).padStart(2, "0");
                        const newDate = `${year}-${month}-${dayOfMonth}`;

                        setDateTimePreference({
                          ...dateTimePreference,
                          specificDate: newDate,
                          specificTimePeriod: "", // Reset when date changes
                        });
                        setNewAppointmentDate(newDate);
                      }
                    }}
                    fromDate={new Date()}
                    disabled={(date) => {
                      const today = new Date();
                      today.setHours(0, 0, 0, 0);
                      return date < today;
                    }}
                    numberOfMonths={1}
                    showOutsideDays={false}
                    className="w-full"
                  />
                </div>
              </div>

              {/* Time period */}
              {dateTimePreference.specificDate && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-3">
                    {labels.selectTimePeriod}
                  </label>
                  <div className="space-y-4">
                    {/* Morning + Evening cards */}
                    <div className="grid grid-cols-2 gap-3">
                      <div
                        className={`p-3 border-2 rounded-lg cursor-pointer transition-all text-center ${
                          dateTimePreference.specificTimePeriod === "morning"
                            ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                            : "border-gray-200 hover:border-indigo-300 hover:bg-gray-50"
                        }`}
                        onClick={() =>
                          setDateTimePreference({
                            ...dateTimePreference,
                            specificTimePeriod: "morning",
                          })
                        }
                      >
                        <div className="text-lg font-semibold">🌅</div>
                        <div className="text-sm font-medium mt-1">Morning</div>
                        <div className="text-xs text-gray-500 mt-1">
                          {labels.morningAnyHour}
                        </div>
                      </div>

                      <div
                        className={`p-3 border-2 rounded-lg cursor-pointer transition-all text-center ${
                          dateTimePreference.specificTimePeriod === "evening"
                            ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                            : "border-gray-200 hover:border-indigo-300 hover:bg-gray-50"
                        }`}
                        onClick={() =>
                          setDateTimePreference({
                            ...dateTimePreference,
                            specificTimePeriod: "evening",
                          })
                        }
                      >
                        <div className="text-lg font-semibold">🌆</div>
                        <div className="text-sm font-medium mt-1">Evening</div>
                        <div className="text-xs text-gray-500 mt-1">
                          {labels.eveningAnyHour}
                        </div>
                      </div>
                    </div>

                    {/* Hour cards 9-19 */}
                    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-4 gap-2">
                      {Array.from({ length: 11 }, (_, i) => {
                        const hour = 9 + i;
                        const timeString = `${hour.toString().padStart(2, "0")}:00`;
                        return (
                          <div
                            key={timeString}
                            className={`p-2 border-2 rounded-lg cursor-pointer transition-all text-center ${
                              dateTimePreference.specificTimePeriod === timeString
                                ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                                : "border-gray-200 hover:border-indigo-300 hover:bg-gray-50"
                            }`}
                            onClick={() =>
                              setDateTimePreference({
                                ...dateTimePreference,
                                specificTimePeriod: timeString,
                              })
                            }
                          >
                            <div className="text-sm font-semibold">
                              {hour}:00
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
