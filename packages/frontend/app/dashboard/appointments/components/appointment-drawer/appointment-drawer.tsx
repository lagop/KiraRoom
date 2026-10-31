"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { User, Phone, Mail, Save } from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
} from "@/components/ui/drawer";
import { ConfirmDialog } from "@/src/components/ui/ConfirmDialog";
import apiClient, { ApiError } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useToast } from "@/components/ui/use-toast";
import { ServiceTimeline } from "@/components/Calendar/ServiceTimeline";
import { salonInstant } from "@/components/Calendar/salon-time";
// Pure helpers — extracted from this file so they can be unit-tested
// from Node. The drawer bridges these into React state.
import {
  buildStaffBookingPayload,
  formatEuros,
  getTotalDuration,
  getTotalPrice,
  asksFirst,
  salonTermsForm,
  salonTermsInvalid,
  salonTermsUpdate,
  sendStatusChange,
  serverMessage,
  type AskedStatus,
  type SalonTermsForm,
} from "../appointment-drawer.utils";
import { planSlotSearch, type SlotSuggestion } from "../slot-suggestions";
import { localDay } from "@/components/Calendar/day-grid";
import { StatusChangeDialog } from "../StatusChangeDialog";
// Phase 1+2+5 refactor — primitives, data hooks, and section components.
// See .kilo/plans/appointment-drawer-refactor.md.
import { useAppointmentCatalog } from "./hooks/useAppointmentCatalog";
import { useAppointmentData } from "./hooks/useAppointmentData";
import { useAppointmentFormState } from "./hooks/useAppointmentFormState";
import type { SelectedService } from "./hooks/useAppointmentFormState";
import { useAppointmentSuggestions } from "./hooks/useAppointmentSuggestions";
import { AppointmentHeader } from "./sections/AppointmentHeader";
import { ActivitySection } from "./sections/ActivitySection";
import { AppointmentSuggestionsSection } from "./sections/AppointmentSuggestionsSection";
import { ClientPickerSection } from "./sections/ClientPickerSection";
import { ServicePickerSection } from "./sections/ServicePickerSection";
import { DateTimePickerSection } from "./sections/DateTimePickerSection";
import { EditModeActions } from "./sections/EditModeActions";
import { ScheduleCard } from "./cards/ScheduleCard";
import { NotesCard } from "./cards/NotesCard";
import { ServiceCard } from "./cards/ServiceCard";
import { AddonsCard } from "./cards/AddonsCard";
import { PaymentSummaryCard } from "./cards/PaymentSummaryCard";
import { SalonTermsCard } from "./cards/SalonTermsCard";
import type {
  Appointment,
  AppointmentDrawerProps,
  AppointmentStatus,
} from "./types";

/** Add-ons as the server stores them, to tell whether an edit changed them. */
function addonKey(addons: ReadonlyArray<{ id: string; quantity: number }>): string {
  return JSON.stringify(addons.map((a) => [String(a.id), Number(a.quantity) || 0]));
}

export function AppointmentDrawer({
  appointmentId,
  open,
  onOpenChange,
  onAppointmentUpdated,
  refreshKey,
  startInEditMode = false,
}: AppointmentDrawerProps) {
  const t = useTranslations();
  const { toast } = useToast();

  // Local component state that does NOT belong in the data hooks.
  const [updating, setUpdating] = useState(false);
  const [editMode, setEditMode] = useState(false);
  // A completed appointment keeps its services, day and time, but its
  // notes can still be edited (the server allows it).
  const [notesEditMode, setNotesEditMode] = useState(false);
  // Commission and deposit while editing (owner and managers only).
  const [terms, setTerms] = useState<SalonTermsForm | null>(null);
  // The server's reason when a new appointment is in the past or outside
  // the hours: an owner or manager may confirm it (a walk-in, a visit
  // entered afterwards).
  const [outsideHoursReason, setOutsideHoursReason] = useState<string | null>(null);

  // Create-mode form state lives in useAppointmentFormState, the free-slot
  // suggestions in useAppointmentSuggestions.
  const {
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
  } = useAppointmentFormState();

  const {
    appointmentSuggestions,
    selectedSuggestion,
    setSelectedSuggestion,
    suggestionsLoading,
    suggestionsError,
    searched,
    generate: generateSuggestions,
    clearSuggestions,
  } = useAppointmentSuggestions();

  // Order matters here: `useAppointmentData` reads `services` (for the
  // add-ons), so the catalog hook must run first.
  const {
    services,
    professionals,
    clients,
    currentUser,
    allowProfessionalCrossBooking,
    timezone,
    refreshAll: refreshCatalog,
  } = useAppointmentCatalog(open);
  const {
    appointment,
    setAppointment,
    loading,
    loadError,
    editedAppointment,
    setEditedAppointment,
    currentAddons,
    setCurrentAddons,
    activityLoading,
    refreshAppointment,
    refreshActivity,
  } = useAppointmentData(appointmentId, refreshKey, services, editMode, open);

  const manager = currentUser?.role === "owner" || currentUser?.role === "admin";

  // The catalog (professionals, clients, the salon's time zone) is fetched
  // again each time the drawer opens.
  useEffect(() => {
    if (open) refreshCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Opening, closing, or moving to another appointment starts from a clean
  // form. The appointment itself is fetched by useAppointmentData (once:
  // this effect used to fetch it a second time). An edit in progress used
  // to survive a switch, and saving it wrote one appointment's day and time
  // onto the next.
  useEffect(() => {
    setEditMode(false);
    setNotesEditMode(false);
    setEditedAppointment(null);
    setCurrentAddons([]);
    setTerms(null);
    setOutsideHoursReason(null);
    if (open && !appointmentId) {
      resetForNewAppointment();
      setAutoAssignMap({});
      clearSuggestions();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId, open]);

  // The visit for the suggestions: the services picked, or the one in the
  // single-service dropdown. Memoised so the effect below does not loop.
  const effectiveSelectedServices: SelectedService[] = useMemo(() => {
    if (selectedServices.length > 0) return selectedServices;
    if (newAppointment.serviceId) {
      return [
        {
          serviceId: newAppointment.serviceId,
          professionalId: newAppointment.professionalId || "",
          isParallel: false,
        },
      ];
    }
    return [];
  }, [selectedServices, newAppointment.serviceId, newAppointment.professionalId]);

  const visitMinutes = getTotalDuration(selectedServices, services, newAppointment.serviceId);
  const suggestionsReady =
    effectiveSelectedServices.some((s) => s.serviceId) &&
    planSlotSearch(dateTimePreference, localDay()) !== null;

  const runSuggestions = () =>
    generateSuggestions({
      selectedServices: effectiveSelectedServices,
      professionals,
      preference: dateTimePreference,
      durationMinutes: visitMinutes,
    });

  // Ask the server again when the visit or the preference changes, after a
  // short pause so picking a service and then its professional is one search.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (appointmentId || !open) return;
    if (!suggestionsReady) {
      clearSuggestions();
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSuggestions();
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // `generateSuggestions` and `clearSuggestions` are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId, open, suggestionsReady, effectiveSelectedServices, dateTimePreference, professionals, visitMinutes]);

  const handleSelectSuggestion = (suggestion: SlotSuggestion) => {
    setSelectedSuggestion(suggestion);
    setNewAppointment((prev) => ({ ...prev, date: suggestion.date, time: suggestion.startTime }));
    // "Anyone": the professional free at that time takes the first service.
    const first = effectiveSelectedServices[0];
    if (first && !first.professionalId && suggestion.professionalId) {
      setAutoAssignMap((prev) => ({ ...prev, [first.serviceId]: suggestion.professionalId! }));
    }
  };

  const handleCreateAppointment = async (allowOutsideHours = false) => {
    // One request for the whole visit: the server creates the appointment
    // and its services together, times them, and checks the agenda.
    const payload = buildStaffBookingPayload({
      role: currentUser?.role,
      ownProfessionalId: currentUser?.professionalId,
      clientId: newAppointment.clientId,
      serviceId: newAppointment.serviceId,
      professionalId: newAppointment.professionalId,
      date: newAppointment.date,
      time: newAppointment.time,
      notes: newAppointment.notes,
      selectedServices,
      autoAssign: autoAssignMap,
      // The deposit is the salon's term, as the commission.
      depositRequired: manager && newAppointment.depositRequired,
      depositAmount: newAppointment.depositAmount,
      commissionRate: newAppointment.commissionRate,
      allowOutsideHours,
    });
    if (!payload) {
      toast({ title: t("appointments.drawer.selectSuggestionOrDate"), variant: "destructive" });
      return;
    }

    setUpdating(true);
    try {
      // Every dashboard role books through /appointments/staff: the salon
      // comes from the token, and the salon may book outside the online grid.
      await apiClient.createAppointmentByStaff(payload);

      setOutsideHoursReason(null);
      clearNewAppointment();
      clearSuggestions();

      onOpenChange(false);
      onAppointmentUpdated?.();
    } catch (error) {
      console.error("Error creating appointment:", error);
      if (error instanceof ApiError && error.code === "OUTSIDE_HOURS" && manager && !allowOutsideHours) {
        setOutsideHoursReason(error.message);
        return;
      }
      setOutsideHoursReason(null);
      // The server says why (taken slot, outside the hours, not your agenda).
      toast({
        title: t("appointments.drawer.failedToCreate"),
        description: serverMessage(error),
        variant: "destructive",
      });
    } finally {
      setUpdating(false);
    }
  };

  const handleServiceToggle = (
    serviceId: string,
    professionalId?: string,
    isParallel: boolean = false,
  ) => {
    const existing = selectedServices.find((s) => s.serviceId === serviceId);
    if (existing) {
      setSelectedServices(selectedServices.filter((s) => s.serviceId !== serviceId));
    } else {
      setSelectedServices([
        ...selectedServices,
        { serviceId, professionalId: professionalId || undefined, isParallel },
      ]);
    }
    setNewAppointment({ ...newAppointment, serviceId: "", professionalId: "", time: "" });
  };

  // Cancelling and a no-show tell the client, and completing is final and
  // may issue an invoice, so they are asked first.
  const [askingStatus, setAskingStatus] = useState<AskedStatus | null>(null);

  const requestStatusChange = (newStatus: AppointmentStatus) => {
    if (asksFirst(newStatus)) {
      setAskingStatus(newStatus);
    } else {
      void handleStatusChange(newStatus);
    }
  };

  const handleStatusChange = async (newStatus: AppointmentStatus, reason?: string) => {
    if (!appointment) return;

    setUpdating(true);
    try {
      // Cancel, complete and no-show go to their own routes, which send the
      // notices, tell the wait-list and issue the invoice.
      await sendStatusChange(apiClient, appointment.id, newStatus, reason);
      setAppointment((prev) => (prev && prev.id === appointment.id ? { ...prev, status: newStatus } : prev));
      // The list behind the drawer showed the old status until reloaded.
      onAppointmentUpdated?.();
    } catch (error) {
      console.error("Error updating appointment status:", error);
      // The server's reason, e.g. "Una cita cancelada no puede pasar a
      // completada.", rather than only "Error al actualizar".
      toast({
        title: t("appointments.drawer.failedToUpdateStatus"),
        description: serverMessage(error),
        variant: "destructive",
      });
    } finally {
      setUpdating(false);
      setAskingStatus(null);
    }
  };

  const handleEditClick = () => {
    if (!appointment) return;
    // A completed appointment keeps its services, day and time; its notes
    // have their own edit button.
    if (appointment.status === "completed") return;
    setEditedAppointment({
      ...appointment,
      service: { ...appointment.service },
      professional: { ...appointment.professional },
      addons: [...appointment.addons],
    });
    setCurrentAddons([...appointment.addons]);
    setTerms(salonTermsForm(appointment));
    setNotesEditMode(false);
    setEditMode(true);
  };

  const leaveEdit = () => {
    const changedRows = editMode;
    setEditMode(false);
    setNotesEditMode(false);
    setEditedAppointment(null);
    setTerms(null);
    // The services card edits the appointment's rows in place: read them
    // back so a cancelled edit leaves nothing behind.
    if (changedRows) void refreshAppointment();
  };

  // "Editar" on the appointment's detail page opens the drawer straight in
  // edit mode, once per opening, as soon as that appointment has loaded.
  const autoEditedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) {
      autoEditedFor.current = null;
      return;
    }
    if (
      startInEditMode &&
      appointment &&
      appointment.id === appointmentId &&
      autoEditedFor.current !== appointmentId
    ) {
      autoEditedFor.current = appointmentId;
      handleEditClick();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startInEditMode, appointment, appointmentId]);

  const handleUpdate = async () => {
    if (!appointment || !editedAppointment) return;
    // Always sent, empty included: "" is how notes are cleared. An empty
    // field used to fall back to the old notes and was never sent.
    const notes = editedAppointment.notes ?? appointment.notes ?? "";

    // Notes only (a completed appointment, or the notes button alone).
    if (notesEditMode && !editMode) {
      setUpdating(true);
      try {
        await apiClient.updateAppointment(appointment.id, { notes });
        setAppointment((prev) => (prev && prev.id === appointment.id ? { ...prev, notes } : prev));
        setNotesEditMode(false);
        setEditedAppointment(null);
        onAppointmentUpdated?.();
      } catch (error) {
        console.error("Error updating appointment notes:", error);
        toast({
          title: t("appointments.drawer.failedToUpdate"),
          description: serverMessage(error),
          variant: "destructive",
        });
      } finally {
        setUpdating(false);
      }
      return;
    }

    const dateValue = editedAppointment.date || appointment.date;
    const timeValue = editedAppointment.time || appointment.time;
    if (!dateValue || !timeValue) {
      toast({ title: t("appointments.drawer.provideDateAndTime"), variant: "destructive" });
      return;
    }
    if (isNaN(new Date(`${dateValue}T${timeValue}`).getTime())) {
      toast({ title: t("appointments.drawer.provideValidDateAndTime"), variant: "destructive" });
      return;
    }
    const termsForm = terms ?? salonTermsForm(appointment);
    if (manager && salonTermsInvalid(termsForm)) {
      toast({ title: t("appointments.drawer.invalidTerms"), variant: "destructive" });
      return;
    }

    setUpdating(true);
    try {
      // The calendar day as the salon sees it (not a UTC instant built from
      // the browser's clock, which landed a day off on either side of UTC).
      const updateData: any = {
        notes,
        scheduledDate: dateValue,
        scheduledTime: timeValue,
      };

      if (editedAppointment.service && editedAppointment.service.id !== appointment.service.id) {
        updateData.serviceId = editedAppointment.service.id;
      }
      if (
        editedAppointment.professional &&
        editedAppointment.professional.id !== appointment.professional.id
      ) {
        updateData.professionalId = editedAppointment.professional.id;
      }

      // Commission and deposit: only what changed, the deposit in cents, a
      // 0 % commission kept as 0. They used to be dropped from every edit.
      Object.assign(
        updateData,
        salonTermsUpdate({ role: currentUser?.role, before: appointment, form: termsForm }),
      );

      // All the add-ons, also none: removing the last one used to be lost.
      if (addonKey(currentAddons) !== addonKey(appointment.addons)) {
        updateData.addons = currentAddons.map((a) => ({ addonId: a.id, quantity: a.quantity }));
      }

      // A visit of several services: its rows with their professionals.
      if (appointment.services && appointment.services.length > 0) {
        updateData.services = appointment.services.map((svc: any) => ({
          serviceId: svc.service?.id || svc.serviceId,
          professionalId: svc.professional?.id || svc.professionalId || null,
          isParallel: svc.isParallel || false,
        }));
      }

      await apiClient.updateAppointment(appointment.id, updateData);

      setEditMode(false);
      setEditedAppointment(null);
      setTerms(null);
      onOpenChange(false);
      onAppointmentUpdated?.();
    } catch (error) {
      console.error("Error updating appointment:", error);
      toast({
        title: t("appointments.drawer.failedToUpdate"),
        description: serverMessage(error),
        variant: "destructive",
      });
    } finally {
      setUpdating(false);
    }
  };

  const handleServiceChange = (serviceId: string) => {
    const selectedService = services.find((s) => String(s.id) === serviceId);
    setEditedAppointment((prev) => {
      if (!prev || !selectedService) return prev;
      return {
        ...prev,
        service: {
          ...prev.service!,
          id: serviceId,
          name: selectedService.name,
          price: selectedService.price || prev.service?.price || 0,
        },
      };
    });
  };

  const failureToast = (title: string) => (error: unknown) => {
    console.error(title, error);
    toast({ title, description: serverMessage(error), variant: "destructive" });
  };

  const inputClass =
    "w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none";

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="h-full overflow-y-auto lg:w-1/2 lg:max-w-[50vw] flex flex-col">
        <DrawerHeader className="px-4 sm:px-6">
          <AppointmentHeader appointmentId={appointmentId} />
        </DrawerHeader>

        <div className="px-4 sm:px-6 pb-6 space-y-6">
          {(loading && !appointment) || (appointment && appointmentId && appointment.id !== appointmentId) ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
              <span className="ml-3">{t("appointments.drawer.loadingDetails")}</span>
            </div>
          ) : !appointmentId ? (
            // New Appointment Form
            <div>
              {/* Step 1: Client Selection */}
              <ClientPickerSection
                clients={clients}
                selectedClientId={newAppointment.clientId}
                onSelect={(client) => {
                  setNewAppointment({ ...newAppointment, clientId: client.id });
                }}
                onSearchClear={() => {
                  // Clearing the search also clears the chosen client.
                  setNewAppointment({ ...newAppointment, clientId: "" });
                }}
              />

              {/* Step 2: Service Selection */}
              <ServicePickerSection
                services={services}
                professionals={professionals}
                selectedServices={selectedServices}
                newAppointment={newAppointment}
                currentUser={currentUser}
                allowProfessionalCrossBooking={allowProfessionalCrossBooking}
                onToggle={(serviceId, professionalId) =>
                  handleServiceToggle(serviceId, professionalId)
                }
                onServiceProfessionalChange={(serviceId, professionalId) => {
                  const updated = selectedServices.map((s) =>
                    s.serviceId === serviceId
                      ? { ...s, professionalId: professionalId || undefined }
                      : s,
                  );
                  setSelectedServices(updated);
                  setNewAppointment({ ...newAppointment, time: "" });
                }}
                onParallelChange={(serviceId, isParallel) => {
                  const updated = selectedServices.map((s) =>
                    s.serviceId === serviceId ? { ...s, isParallel } : s,
                  );
                  setSelectedServices(updated);
                  setNewAppointment({ ...newAppointment, time: "" });
                }}
                onSingleServiceChange={(serviceId) => {
                  const professionalId =
                    currentUser?.role === "staff" &&
                    !allowProfessionalCrossBooking &&
                    currentUser.professionalId
                      ? currentUser.professionalId
                      : "";
                  // Picking from the dropdown seeds `selectedServices` so
                  // the multi-service cards view becomes available.
                  setSelectedServices((prev) => {
                    if (prev.some((s) => s.serviceId === serviceId)) return prev;
                    return [...prev, { serviceId, professionalId, isParallel: false }];
                  });
                  setNewAppointment({ ...newAppointment, serviceId, professionalId, time: "" });
                }}
                onSingleProfessionalChange={(professionalId) => {
                  setNewAppointment({ ...newAppointment, professionalId });
                  // Keep the seeded selectedServices entry in sync so the
                  // suggestions see the right professional.
                  if (newAppointment.serviceId) {
                    setSelectedServices((prev) =>
                      prev.map((s) =>
                        s.serviceId === newAppointment.serviceId ? { ...s, professionalId } : s,
                      ),
                    );
                  }
                }}
                totalPrice={getTotalPrice(selectedServices, services, newAppointment.serviceId)}
                totalDuration={visitMinutes}
                labels={{
                  services: t("appointments.services"),
                  selected: t("appointments.selected"),
                  professional: t("pos.professional"),
                  autoAssign: t("appointments.drawer.autoAssign"),
                  runInParallel: t("appointments.drawer.runInParallel"),
                  selectAService: t("appointments.select_a_service"),
                  selectAProfessional: t("appointments.select_professional"),
                  pickOneHint: t("appointments.drawer.pickOneHint"),
                  totalPrice: t("appointments.drawer.totalPrice"),
                  totalDuration: t("appointments.drawer.totalDuration"),
                  assignedTo: (name) => t("appointments.drawer.assignedTo", { name }),
                }}
              />

              {/* Step 3: Date/Time Preferences */}
              <DateTimePickerSection
                dateTimePreference={dateTimePreference}
                setDateTimePreference={setDateTimePreference}
                newAppointmentDate={newAppointment.date}
                setNewAppointmentDate={(date) =>
                  setNewAppointment((prev) => ({ ...prev, date }))
                }
                hasServices={selectedServices.length > 0}
                labels={{
                  dateTimePreferences: t("appointments.date_time_preferences"),
                  selectATimePreference: t("appointments.drawer.selectATimePreference"),
                  pleaseSelectDateTime: t("appointments.drawer.pleaseSelectDateTime"),
                  nextTimeSlotAvailable: t("appointments.drawer.nextTimeSlotAvailable"),
                  todayMorning: t("appointments.drawer.todayMorning"),
                  todayAfternoon: t("appointments.drawer.todayAfternoon"),
                  flexibleTimingPreferences: t("appointments.drawer.flexibleTimingPreferences"),
                  morningPreferred: t("appointments.drawer.morningPreferred"),
                  afternoonPreferred: t("appointments.drawer.afternoonPreferred"),
                  specificDateAndTime: t("appointments.drawer.specificDateAndTime"),
                  selectDate: t("appointments.drawer.selectDate"),
                  selectTimePeriod: t("appointments.drawer.selectTimePeriod"),
                  morning: t("appointments.drawer.morning"),
                  evening: t("appointments.drawer.evening"),
                  morningAnyHour: t("appointments.drawer.morningAnyHour"),
                  eveningAnyHour: t("appointments.drawer.eveningAnyHour"),
                }}
              />

              {/* Free times from the server */}
              <AppointmentSuggestionsSection
                ready={suggestionsReady}
                severalServices={effectiveSelectedServices.length > 1}
                appointmentSuggestions={appointmentSuggestions}
                selectedSuggestion={selectedSuggestion}
                suggestionsLoading={suggestionsLoading}
                suggestionsError={suggestionsError}
                searched={searched}
                specificSearch={dateTimePreference.type === "specific"}
                onGenerate={() => void runSuggestions()}
                onSelect={handleSelectSuggestion}
              />

              {/* Cross-booking setting status - shown for owners/admins */}
              {currentUser?.role !== "staff" && (
                <div className="bg-white rounded-xl border border-gray-200 p-6 my-4">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">
                    {t("appointments.drawer.crossBookingTitle")}
                  </h4>
                  <div
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      allowProfessionalCrossBooking
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                        allowProfessionalCrossBooking ? "bg-green-400" : "bg-gray-400"
                      }`}
                    ></span>
                    {allowProfessionalCrossBooking
                      ? t("appointments.drawer.crossBookingOn")
                      : t("appointments.drawer.crossBookingOff")}
                  </div>
                </div>
              )}

              {/* Notes */}
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <label htmlFor="new-appointment-notes" className="block text-lg font-semibold text-gray-900 mb-4">
                  {t("appointments.notes")}
                </label>
                <textarea
                  id="new-appointment-notes"
                  value={newAppointment.notes}
                  onChange={(e) => setNewAppointment({ ...newAppointment, notes: e.target.value })}
                  rows={3}
                  className={inputClass}
                  placeholder={t("appointments.additional_notes")}
                />
              </div>

              {/* Deposit and commission: the salon's terms (owner/admin only) */}
              {manager && (
                <div className="border-t pt-4 mt-4">
                  <h3 className="text-lg font-semibold text-gray-900 mb-4">
                    {t("appointments.deposit_payment")}
                  </h3>
                  <div className="space-y-4">
                    <label className="flex items-center">
                      <input
                        type="checkbox"
                        checked={newAppointment.depositRequired}
                        onChange={(e) =>
                          setNewAppointment({ ...newAppointment, depositRequired: e.target.checked })
                        }
                        className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                      />
                      <span className="ml-2 text-gray-700">{t("appointments.require_deposit")}</span>
                    </label>

                    {newAppointment.depositRequired && (
                      <div>
                        <label htmlFor="new-appointment-deposit" className="block text-sm font-medium text-gray-700 mb-1">
                          {t("appointments.deposit_amount")}
                        </label>
                        <input
                          id="new-appointment-deposit"
                          type="number"
                          step="0.01"
                          min="0"
                          value={newAppointment.depositAmount || ""}
                          onChange={(e) =>
                            setNewAppointment({
                              ...newAppointment,
                              // Euros, as typed: the payload turns them into cents.
                              depositAmount: parseFloat(e.target.value) || 0,
                            })
                          }
                          className={inputClass}
                          placeholder={t("appointments.deposit_amount_placeholder")}
                        />
                        <p className="text-sm text-gray-500 mt-1">
                          {t("appointments.calendarView.depositHint")}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="mt-4">
                    <label htmlFor="new-appointment-commission" className="block text-sm font-medium text-gray-700 mb-1">
                      {t("appointments.commission_rate")} (%)
                    </label>
                    <input
                      id="new-appointment-commission"
                      type="number"
                      min="0"
                      max="100"
                      step="0.5"
                      value={newAppointment.commissionRate ?? ""}
                      onChange={(e) =>
                        setNewAppointment({
                          ...newAppointment,
                          // Empty: the professional's rate. 0 is 0 %.
                          commissionRate: e.target.value === "" ? undefined : Number(e.target.value),
                        })
                      }
                      className={inputClass}
                      placeholder={t("appointments.leave_empty_default_rate")}
                    />
                    <p className="text-sm text-gray-500 mt-1">
                      {t("appointments.commission_rate_description")}
                    </p>
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex justify-end space-x-3 mt-6">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  {t("appointments.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => handleCreateAppointment()}
                  disabled={updating}
                  className="inline-flex items-center px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50"
                >
                  {updating ? (
                    <>
                      <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full mr-2"></div>
                      {t("appointments.creating")}
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4 mr-2" />
                      {t("appointments.create_appointment")}{" "}
                      {selectedServices.length > 0 &&
                        `(${formatEuros(getTotalPrice(selectedServices, services, newAppointment.serviceId))})`}
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : appointment ? (
            <div>
              {/* Status and Actions Bar */}
              <EditModeActions
                appointment={appointment}
                editMode={editMode}
                notesEditMode={notesEditMode}
                updating={updating}
                onEnterEdit={handleEditClick}
                onCancelEdit={leaveEdit}
                onSave={handleUpdate}
                onStatusChange={requestStatusChange}
                labels={{
                  created: t("appointments.created"),
                  viewMode: t("appointments.view_mode"),
                  saving: t("appointments.saving"),
                  save: t("appointments.save"),
                  edit: t("appointments.edit"),
                  updating: t("appointments.updating"),
                  confirm: t("appointments.confirm"),
                  cancel: t("appointments.cancel"),
                  start: t("appointments.start"),
                  complete: t("appointments.complete"),
                  noShow: t("appointments.no_show"),
                }}
              />
              {/* In place, not portalled: the drawer is a modal dialog. */}
              <StatusChangeDialog
                to={askingStatus}
                loading={updating}
                portal={false}
                onCancel={() => setAskingStatus(null)}
                onConfirm={(reason) => {
                  if (askingStatus) void handleStatusChange(askingStatus, reason);
                }}
              />

              {/* Main Content */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
                {/* Left Column - Appointment Info */}
                <div className="lg:col-span-2 space-y-6">
                  <ScheduleCard
                    appointment={appointment}
                    editMode={editMode}
                    editedDate={editedAppointment?.date || appointment.date}
                    editedTime={editedAppointment?.time || appointment.time}
                    onEnterEditMode={handleEditClick}
                    onDateChange={(date) =>
                      setEditedAppointment((prev) => (prev ? { ...prev, date } : prev))
                    }
                    onTimeChange={(time) =>
                      setEditedAppointment((prev) => (prev ? { ...prev, time } : prev))
                    }
                    labels={{
                      schedule: t("appointments.schedule"),
                      date: t("appointments.date"),
                      time: t("appointments.time"),
                      edit: t("appointments.drawer.editSchedule"),
                    }}
                  />

                  <ServiceCard
                    appointment={appointment}
                    editedAppointment={editedAppointment}
                    editMode={editMode}
                    services={services}
                    professionals={professionals}
                    selectedAddon={selectedAddon}
                    onEnterEditMode={handleEditClick}
                    onServiceChange={handleServiceChange}
                    onRemoveService={(index) => {
                      setAppointment((prev) =>
                        prev
                          ? { ...prev, services: prev.services?.filter((_, i) => i !== index) }
                          : null,
                      );
                    }}
                    onUpdateProfessional={(index, professionalId) => {
                      const selectedProf = professionals.find(
                        (p) => String(p.id) === professionalId,
                      );
                      setAppointment((prev) => {
                        if (!prev) return null;
                        const updatedServices = prev.services?.map((svc, i) =>
                          i === index
                            ? {
                                ...svc,
                                professional: selectedProf
                                  ? {
                                      id: selectedProf.id,
                                      firstName: selectedProf.firstName,
                                      lastName: selectedProf.lastName,
                                      email: selectedProf.email,
                                      phone: selectedProf.phone,
                                      specialties: selectedProf.specialties,
                                    }
                                  : undefined,
                              }
                            : svc,
                        );
                        return { ...prev, services: updatedServices };
                      });
                    }}
                    onSelectedAddonChange={setSelectedAddon}
                    onAddService={() => {
                      const service = services.find((s) => String(s.id) === selectedAddon);
                      if (!service) return;
                      const newService = {
                        id: `temp-${Date.now()}`,
                        service: {
                          id: service.id,
                          name: service.name,
                          duration: service.duration || 0,
                          price: service.price || 0,
                        },
                        isParallel: false,
                        scheduledStart: undefined,
                        scheduledEnd: undefined,
                      };
                      setAppointment((prev) =>
                        prev ? { ...prev, services: [...(prev.services || []), newService] } : null,
                      );
                      setSelectedAddon("");
                    }}
                    labels={{
                      services: t("appointments.services"),
                      service: t("appointments.service"),
                      parallel: t("appointments.parallel"),
                      selectProfessional: t("appointments.select_professional"),
                      addMoreServices: t("appointments.add_more_services"),
                      selectServiceToAdd: t("appointments.select_service_to_add"),
                      add: t("appointments.add"),
                      edit: t("appointments.drawer.editServices"),
                      remove: t("appointments.drawer.removeService"),
                    }}
                  />

                  <AddonsCard
                    appointment={appointment}
                    editMode={editMode}
                    currentAddons={currentAddons}
                    services={services}
                    selectedAddon={selectedAddon}
                    addonQuantity={addonQuantity}
                    editedServiceId={editedAppointment?.service?.id}
                    onSelectedAddonChange={setSelectedAddon}
                    onAddonQuantityChange={setAddonQuantity}
                    onAddAddon={() => {
                      const service = services.find((s) => String(s.id) === selectedAddon);
                      if (!service) return;
                      setCurrentAddons((prev) => [
                        ...prev,
                        {
                          id: service.id,
                          name: service.name,
                          quantity: addonQuantity,
                          price: Number(service.price) || 0,
                          duration: Number(service.duration) || 0,
                        },
                      ]);
                      setSelectedAddon("");
                      setAddonQuantity(1);
                    }}
                    onRemoveAddon={(index) =>
                      setCurrentAddons((prev) => prev.filter((_, i) => i !== index))
                    }
                    labels={{
                      addOns: t("appointments.add_ons"),
                      selectAddOn: t("appointments.select_add_on"),
                      add: t("appointments.add"),
                      quantity: t("appointments.quantity"),
                      remove: t("appointments.drawer.removeAddon"),
                    }}
                  />

                  {/* Service Timeline - Show for multi-service appointments */}
                  {appointment.services && appointment.services.length > 1 && (
                    <div className="bg-white rounded-xl border border-gray-200 p-6">
                      <ServiceTimeline
                        timezone={timezone}
                        services={(() => {
                          // Rows without their own times are laid out from the
                          // appointment's start on the salon's clock.
                          let currentTime = salonInstant(appointment.date, appointment.time, timezone).getTime();

                          return appointment.services.map((svc, index) => {
                            const duration = svc.service?.duration || 0;
                            let scheduledStart: string;
                            let scheduledEnd: string;

                            if (svc.scheduledStart && svc.scheduledEnd) {
                              scheduledStart = svc.scheduledStart;
                              scheduledEnd = svc.scheduledEnd;
                            } else {
                              const startDate = new Date(currentTime);
                              const endDate = new Date(currentTime + duration * 60000);
                              if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
                                const now = new Date();
                                scheduledStart = now.toISOString();
                                scheduledEnd = new Date(now.getTime() + duration * 60000).toISOString();
                              } else {
                                scheduledStart = startDate.toISOString();
                                scheduledEnd = endDate.toISOString();
                              }
                              // Only serial services move the clock on.
                              if (!svc.isParallel) currentTime += duration * 60000;
                            }

                            return {
                              id: svc.id || `temp-${index}`,
                              serviceId: svc.service?.id || "",
                              serviceName: svc.service?.name || t("appointments.service"),
                              professionalId: svc.professional?.id,
                              professionalName: svc.professional
                                ? `${svc.professional.firstName} ${svc.professional.lastName}`
                                : undefined,
                              scheduledStart,
                              scheduledEnd,
                              isParallel: svc.isParallel || false,
                              order: index,
                              duration,
                              price: svc.service?.price || 0,
                            };
                          });
                        })()}
                        editable={editMode && appointment.status !== "completed"}
                        onReorder={async (reorderedServices) => {
                          try {
                            await apiClient.reorderAppointmentServices(
                              appointment.id,
                              reorderedServices.map((svc, index) => ({ serviceId: svc.serviceId, order: index })),
                            );
                            await refreshAppointment();
                          } catch (error) {
                            failureToast(t("appointments.drawer.failedToReorderServices"))(error);
                          }
                        }}
                        onTimeChange={async (serviceId, scheduledStart, scheduledEnd) => {
                          try {
                            await apiClient.updateAppointmentServiceTiming(serviceId, scheduledStart, scheduledEnd);
                            await refreshAppointment();
                          } catch (error) {
                            failureToast(t("appointments.drawer.failedToUpdateServiceTiming"))(error);
                          }
                        }}
                        onModeToggle={async (serviceId, isParallel) => {
                          try {
                            await apiClient.toggleAppointmentServiceMode(serviceId, isParallel);
                            await refreshAppointment();
                          } catch (error) {
                            failureToast(t("appointments.drawer.failedToToggleServiceMode"))(error);
                          }
                        }}
                      />
                    </div>
                  )}

                  {/* Client Card */}
                  <div className="bg-white rounded-xl border border-gray-200 p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-lg font-semibold text-gray-900">{t("appointments.client")}</h2>
                      <a
                        href={`/dashboard/clients/${appointment.client.id}`}
                        className="text-sm text-indigo-600 hover:text-indigo-700"
                      >
                        {t("appointments.view_profile")}
                      </a>
                    </div>
                    <div className="flex items-start space-x-4">
                      <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center flex-shrink-0">
                        <User className="w-6 h-6 text-indigo-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-gray-900">{appointment.client.name}</h3>
                        <div className="mt-2 space-y-2">
                          {appointment.client.email && (
                            <a
                              href={`mailto:${appointment.client.email}`}
                              className="flex items-center text-sm text-gray-600 hover:text-indigo-600 break-all"
                            >
                              <Mail className="w-4 h-4 mr-2 text-gray-400 flex-shrink-0" />
                              {appointment.client.email}
                            </a>
                          )}
                          {appointment.client.phone && (
                            <a
                              href={`tel:${appointment.client.phone}`}
                              className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                            >
                              <Phone className="w-4 h-4 mr-2 text-gray-400 flex-shrink-0" />
                              {appointment.client.phone}
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Professional Card - one service; a visit shows them per service */}
                  {(!appointment.services || appointment.services.length === 0) && (
                    <div className="bg-white rounded-xl border border-gray-200 p-6">
                      <div className="flex items-center justify-between gap-2 mb-4">
                        <h2 className="text-lg font-semibold text-gray-900">{t("appointments.professional")}</h2>
                        {editMode ? (
                          <select
                            aria-label={t("appointments.professional")}
                            value={editedAppointment?.professional?.id || appointment.professional.id}
                            onChange={(e) => {
                              setEditedAppointment((prev) => {
                                if (!prev) return null;
                                const selectedProfessional = professionals.find(
                                  (p) => String(p.id) === e.target.value,
                                );
                                if (!selectedProfessional) return prev;
                                return {
                                  ...prev,
                                  professional: {
                                    ...prev.professional!,
                                    id: e.target.value,
                                    name: `${selectedProfessional.firstName} ${selectedProfessional.lastName}`,
                                  },
                                };
                              });
                            }}
                            className="border border-gray-300 rounded px-2 py-1 text-sm min-w-0"
                          >
                            {professionals
                              .filter((prof) =>
                                prof.services?.some(
                                  (ps) =>
                                    ps.serviceId ===
                                    (editedAppointment?.service?.id || appointment.service.id),
                                ),
                              )
                              .map((professional) => (
                                <option key={professional.id} value={professional.id}>
                                  {professional.firstName} {professional.lastName}
                                </option>
                              ))}
                          </select>
                        ) : (
                          <a
                            href={`/dashboard/professionals/${appointment.professional.id}`}
                            className="text-sm text-indigo-600 hover:text-indigo-700"
                          >
                            {t("appointments.view_profile")}
                          </a>
                        )}
                      </div>
                      <div className="flex items-start space-x-4">
                        <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                          <User className="w-6 h-6 text-green-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h3 className="font-semibold text-gray-900">
                            {editMode && editedAppointment?.professional?.name
                              ? editedAppointment.professional.name
                              : appointment.professional.name}
                          </h3>
                          {appointment.professional.specialty && (
                            <span className="inline-block px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded-full mt-1">
                              {appointment.professional.specialty}
                            </span>
                          )}
                          <div className="mt-2 space-y-2">
                            {appointment.professional.email && (
                              <a
                                href={`mailto:${appointment.professional.email}`}
                                className="flex items-center text-sm text-gray-600 hover:text-indigo-600 break-all"
                              >
                                <Mail className="w-4 h-4 mr-2 text-gray-400 flex-shrink-0" />
                                {appointment.professional.email}
                              </a>
                            )}
                            {appointment.professional.phone && (
                              <a
                                href={`tel:${appointment.professional.phone}`}
                                className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                              >
                                <Phone className="w-4 h-4 mr-2 text-gray-400 flex-shrink-0" />
                                {appointment.professional.phone}
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  {appointment.services && appointment.services.length > 0 && (
                    <div className="bg-white rounded-xl border border-gray-200 p-6">
                      <h2 className="text-lg font-semibold text-gray-900 mb-2">{t("appointments.professionals")}</h2>
                      <p className="text-sm text-gray-600">{t("appointments.professionals_description")}</p>
                    </div>
                  )}
                </div>

                {/* Right Column - Sidebar */}
                <div className="space-y-6">
                  <PaymentSummaryCard
                    appointment={appointment}
                    editMode={editMode}
                    editedServicePrice={editedAppointment?.service?.price}
                    currentAddons={currentAddons}
                  />

                  <NotesCard
                    appointment={appointment}
                    editMode={editMode}
                    notesEditMode={notesEditMode}
                    editedNotes={editedAppointment?.notes ?? appointment.notes}
                    saving={updating}
                    onEnterEditMode={() => {
                      // A completed appointment: its notes only.
                      if (appointment.status === "completed") {
                        setEditedAppointment((prev) => prev ?? { ...appointment });
                        setNotesEditMode(true);
                      } else {
                        handleEditClick();
                      }
                    }}
                    onCancelEdit={leaveEdit}
                    onSave={handleUpdate}
                    onNotesChange={(notes) =>
                      setEditedAppointment((prev) => ({ ...(prev ?? appointment), notes }))
                    }
                    labels={{
                      notes: t("appointments.notes"),
                      cancel: t("appointments.cancel"),
                      save: t("appointments.save"),
                      saving: t("appointments.saving"),
                      edit: t("appointments.drawer.editNotes"),
                      noNotesForAppointment: t("appointments.no_notes_for_appointment"),
                    }}
                  />

                  {manager && (
                    <SalonTermsCard
                      appointment={appointment}
                      editMode={editMode}
                      form={terms}
                      onChange={setTerms}
                    />
                  )}

                  <ActivitySection
                    appointment={appointment}
                    activityLoading={activityLoading}
                    onToggle={refreshActivity}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-gray-500">{t("appointments.drawer.notFound")}</p>
              {loadError && <p className="text-sm text-red-600 mt-2">{loadError}</p>}
            </div>
          )}
        </div>
        {/* Inside the drawer: the drawer is modal, so a dialog outside it
            could not be clicked. */}
        <ConfirmDialog
          open={outsideHoursReason !== null}
          title={t("appointments.drawer.outsideHoursTitle")}
          description={
            <>
              {outsideHoursReason}{" "}
              {t("appointments.drawer.outsideHoursDescription")}
            </>
          }
          confirmLabel={t("appointments.drawer.outsideHoursConfirm")}
          loading={updating}
          onCancel={() => setOutsideHoursReason(null)}
          onConfirm={() => handleCreateAppointment(true)}
        />
      </DrawerContent>
    </Drawer>
  );
}
