import { useState } from "react";

/**
 * Form state for the appointment drawer.
 *
 * Owns the ~6 hooks that drive the **create-mode** form (and the
 * edit-mode addons):
 *
 *   - `selectedAddon`, `addonQuantity`            edit-mode addons
 *   - `newAppointment`                            create-mode core form
 *   - `dateTimePreference`                        create-mode date/time
 *   - `selectedServices`                          create-mode multi-svc
 *   - `autoAssignMap`                             smart-suggestion cache
 *
 * Verbatim move of `useState` calls from `appointment-drawer.tsx`
 * lines 152-167 + 180-185. The data hooks (`useAppointmentData`,
 * `useAppointmentCatalog`) own their own state; the suggestion
 * engine lives in `useAppointmentSuggestions`. This hook is the
 * "remaining" orchestrator-level form state.
 *
 * The hook intentionally exposes setters so that the suggestion
 * generator (and the create-mode body) can mutate the form freely
 * without leaking the implementation.
 */

export interface SelectedService {
  serviceId: string;
  professionalId?: string;
  isParallel: boolean;
}

export interface NewAppointmentForm {
  clientId: string;
  serviceId: string;
  professionalId: string;
  date: string;
  time: string;
  notes: string;
  depositRequired: boolean;
  depositAmount: number;
  commissionRate: number;
}

export interface DateTimePreference {
  type: string;
  morningPreferred: boolean;
  afternoonPreferred: boolean;
  specificDate: string;
  specificTime: string;
  specificTimePeriod: string;
}

export interface UseAppointmentFormStateResult {
  selectedAddon: string;
  setSelectedAddon: React.Dispatch<React.SetStateAction<string>>;
  addonQuantity: number;
  setAddonQuantity: React.Dispatch<React.SetStateAction<number>>;
  newAppointment: NewAppointmentForm;
  setNewAppointment: React.Dispatch<React.SetStateAction<NewAppointmentForm>>;
  dateTimePreference: DateTimePreference;
  setDateTimePreference: React.Dispatch<
    React.SetStateAction<DateTimePreference>
  >;
  selectedServices: SelectedService[];
  setSelectedServices: React.Dispatch<React.SetStateAction<SelectedService[]>>;
  autoAssignMap: Record<string, string>;
  setAutoAssignMap: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;
  /**
   * Convenience: default the date to tomorrow's ISO yyyy-mm-dd and
   * merge into the existing form. The component calls this once on
   * drawer-open with `appointmentId == null`.
   */
  resetForNewAppointment: () => void;
  /**
   * Convenience: wipe all create-mode form state when the user
   * closes the drawer or switches back to a fresh "new" open.
   */
  clearNewAppointment: () => void;
}

const EMPTY_NEW_APPOINTMENT: NewAppointmentForm = {
  clientId: "",
  serviceId: "",
  professionalId: "",
  date: "",
  time: "",
  notes: "",
  depositRequired: false,
  depositAmount: 0,
  commissionRate: 0,
};

const EMPTY_DATE_TIME_PREFERENCE: DateTimePreference = {
  type: "next_available",
  morningPreferred: false,
  afternoonPreferred: false,
  specificDate: "",
  specificTime: "",
  specificTimePeriod: "",
};

export function useAppointmentFormState(): UseAppointmentFormStateResult {
  const [selectedAddon, setSelectedAddon] = useState("");
  const [addonQuantity, setAddonQuantity] = useState(1);
  const [newAppointment, setNewAppointment] =
    useState<NewAppointmentForm>(EMPTY_NEW_APPOINTMENT);
  const [dateTimePreference, setDateTimePreference] =
    useState<DateTimePreference>(EMPTY_DATE_TIME_PREFERENCE);
  const [selectedServices, setSelectedServices] = useState<SelectedService[]>(
    [],
  );
  const [autoAssignMap, setAutoAssignMap] = useState<Record<string, string>>({});

  const resetForNewAppointment = () => {
    setNewAppointment({
      ...EMPTY_NEW_APPOINTMENT,
      // Default date = tomorrow (verbatim from appointment-drawer.tsx:589-595)
      date: (() => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow.toISOString().split("T")[0];
      })(),
    });
    setSelectedServices([]);
    setDateTimePreference({ ...EMPTY_DATE_TIME_PREFERENCE });
  };

  const clearNewAppointment = () => {
    setNewAppointment(EMPTY_NEW_APPOINTMENT);
    setDateTimePreference(EMPTY_DATE_TIME_PREFERENCE);
    setSelectedServices([]);
    setSelectedAddon("");
    setAddonQuantity(1);
    setAutoAssignMap({});
  };

  return {
    selectedAddon,
    setSelectedAddon,
    addonQuantity,
    setAddonQuantity,
    newAppointment,
    setNewAppointment,
    dateTimePreference,
    setDateTimePreference,
    selectedServices,
    setSelectedServices,
    autoAssignMap,
    setAutoAssignMap,
    resetForNewAppointment,
    clearNewAppointment,
  };
}