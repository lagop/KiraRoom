"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { format } from "date-fns";
import { DayPicker } from "react-day-picker";
import "react-day-picker/dist/style.css";
import {
  Calendar,
  Clock,
  User,
  Scissors,
  DollarSign,
  Phone,
  Mail,
  CheckCircle,
  XCircle,
  AlertCircle,
  Edit,
  Trash2,
  Save,
  X,
  Eye,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Loader2,
  Search,
  Plus,
} from "lucide-react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Button } from "@/src/components/ui/Button";
//import apiClient from '@/lib/api';
import apiClient from "@/lib/api"
import { useTranslations } from "@/lib/use-translation";
import { getCurrentUser } from "@/lib/utils";
import { ServiceTimeline } from "@/components/Calendar/ServiceTimeline";
import { AppointmentScheduler } from "@/lib/appointment-scheduler";
import {
  prepareServiceObjects,
  fetchProfessionalAvailability,
  fetchMultiDayAvailability,
  getTenantSettings,
  transformOptionsForUI,
  validateServicesForScheduling,
  validateAvailabilityData,
  AvailabilityCache,
  generateAvailabilityCacheKey,
  timeToMinutes,
} from "@/lib/appointment-scheduler.utils";
// Pure helpers — extracted from this file so they can be unit-tested
// from Node. The drawer bridges these into React state.
import {
  addMinutesToTime,
  calculateTotalDuration,
  formatDateString,
  formatDateTimeString,
  formatIsoDate,
  getProfessionalName,
  getStatusBadgeStyle,
  getTotalDuration,
  getTotalPrice,
  sumServiceDurations,
  transformAddons,
} from "../appointment-drawer.utils";
import {
  generateFallbackSuggestions as buildFallbackSuggestions,
  type FallbackSuggestion,
} from "../appointment-suggestions";
// Phase 1+2+5 refactor — primitives, data hooks, and section components.
// See .kilo/plans/appointment-drawer-refactor.md.
import { AppointmentStatusBadge } from "./primitives/AppointmentStatusBadge";
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
import type {
  Appointment,
  AppointmentDrawerProps,
  AppointmentStatus,
} from "./types";

export function AppointmentDrawer({
  appointmentId,
  open,
  onOpenChange,
  onAppointmentUpdated,
  refreshKey,
}: AppointmentDrawerProps) {
  const t = useTranslations();

  // Local component state that does NOT belong in the data hooks.
  // Kept here because it crosses concerns (edit-mode toggles,
  // create-mode form state, suggestions, addons, client search).
  const [updating, setUpdating] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [notesEditMode, setNotesEditMode] = useState(false);
  const [isCreatingNew, setIsCreatingNew] = useState(false);

  // State management for edit mode (activity expanded flag — moves to

// Phase 3 refactor — create-mode form state lives in useAppointmentFormState,
// suggestion-engine state in useAppointmentSuggestions.
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
  setAppointmentSuggestions,
  selectedSuggestion,
  setSelectedSuggestion,
  suggestionsLoading,
  suggestionsError,
  availabilityWarnings,
  generate: generateAppointmentSuggestions,
  generateMock: generateMockSuggestions,
  generateFallback: generateFallbackSuggestions,
  clearSuggestions,
} = useAppointmentSuggestions();

// Phase 1+2 refactor — extracted to ./appointment-drawer/hooks/useClickOutside


// Phase 1+2 refactor — appointment data + activity live in
// useAppointmentData, the create-mode catalog (services /
// professionals / clients / tenant timezone / current user) lives in
// useAppointmentCatalog. Order matters here: `useAppointmentData`
// reads `services` (for the addons-transform effect), so the catalog
// hook must run first.
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
  editedAppointment,
  setEditedAppointment,
  currentAddons,
  setCurrentAddons,
  activityLoading,
  refreshAppointment,
  refreshActivity,
} = useAppointmentData(appointmentId, refreshKey, services, editMode, open);

// Helper function to get professional for a service
const getProfessionalForService = (serviceId: string) => {
  const selection = selectedServices.find((s) => s.serviceId === serviceId);
    return selection?.professionalId
      ? professionals.find((p) => p.id === selection.professionalId)
      : null;
  };

  // Phase 3 refactor — generateAppointmentSuggestions /
  // generateMockSuggestions / generateFallbackSuggestions all live in
  // useAppointmentSuggestions. See
  // ./appointment-drawer/hooks/useAppointmentSuggestions.ts. Call sites
  // (line 1758) pass the current form/catalog inputs explicitly.
  // PHASE 3 INLINE DEFINITIONS REMOVED — see ./appointment-drawer/hooks/useAppointmentSuggestions.ts

  // PHASE 3 INLINE DEFINITIONS REMOVED — see ./appointment-drawer/hooks/useAppointmentSuggestions.ts

  // Component initialization
  useEffect(() => {
    // Component initialized
  }, []);

useEffect(() => {
    if (open) {
      // Catalog (professionals / clients / tenant timezone) is
      // refreshed unconditionally when the drawer opens. The
      // services list refresh is owned by `useAppointmentCatalog`'s
      // own effect, gated on `currentUser` being loaded.
      refreshCatalog();

      if (appointmentId) {
        // Editing existing appointment — let fetchAppointment fill everything
        setIsCreatingNew(false);
        refreshAppointment();
      } else {
        // ?? NEW APPOINTMENT: full reset so no stale data leaks in ??
        setIsCreatingNew(true);
        setEditMode(true);
        setAppointment(null);
        setEditedAppointment(null);
        setCurrentAddons([]);
        // Phase 3 helper — wipes the form state and seeds the date
        // to tomorrow. Replaces ~20 lines of inline reset that
        // previously lived here.
        resetForNewAppointment();
        clearSuggestions();
      }
} else {
      // ?? DRAWER CLOSED: clean up leftovers so next open starts fresh ??
      setEditMode(false);
      setEditedAppointment(null);
      setCurrentAddons([]);
    }
  }, [appointmentId, open, refreshKey]);

  // Effective selected-services list for the suggestion engine.
  // Multi-service mode uses `selectedServices` directly; single-service
  // mode synthesizes a one-element list from `newAppointment.serviceId`
  // + `newAppointment.professionalId` so suggestions still appear.
  // `useMemo` keeps the array reference stable so downstream effects
  // don't loop on every render.
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
  const hasSingleServiceContext = Boolean(newAppointment.serviceId);

  // Auto-generate suggestions (with debounce) when the user has enough
  // context. Replaces the prior "clear + generate" pair which fired on
  // every render because `effectiveSelectedServices` was a fresh array
  // literal each pass, causing a clear/generate loop (visible as
  // suggestions blinking in and out).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!newAppointment.clientId) {
      clearSuggestions();
      return;
    }
    if (!dateTimePreference.type) {
      clearSuggestions();
      return;
    }
    if (!newAppointment.date) {
      clearSuggestions();
      return;
    }
    const canGenerate =
      effectiveSelectedServices.length > 0 &&
      effectiveSelectedServices.some((s) => s.serviceId);
    if (!canGenerate) {
      clearSuggestions();
      return;
    }
    if (
      dateTimePreference.type === "specific" &&
      !dateTimePreference.specificTimePeriod
    ) {
      clearSuggestions();
      return;
    }

    // Debounce so rapid input changes (e.g. picking a service then a
    // professional within 100ms) don't fire two overlapping fetches.
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      generateAppointmentSuggestions({
        selectedServices: effectiveSelectedServices,
        services,
        professionals,
        newAppointmentDate: newAppointment.date,
        dateTimePreference,
        setAutoAssignMap,
      });
    }, 250);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // `generateAppointmentSuggestions` and `clearSuggestions` are stable
    // refs from the suggestions hook; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    newAppointment.clientId,
    newAppointment.serviceId,
    newAppointment.professionalId,
    newAppointment.date,
    dateTimePreference,
    effectiveSelectedServices,
    services,
    professionals,
  ]);

  const handleCreateAppointment = async () => {
    const hasMultipleServices = selectedServices.length > 0;

    // Resolve auto-assigned services using the same mapping the scheduler picked
    const resolvedSelectedServices = selectedServices.map((svc) => {
      if (svc.professionalId) return svc;
      const resolved = autoAssignMap[svc.serviceId];
      return { ...svc, professionalId: resolved || "" };
    });

    const serviceId = hasMultipleServices
      ? resolvedSelectedServices[0].serviceId
      : newAppointment.serviceId;

    const selectedProfessionalId = hasMultipleServices
      ? resolvedSelectedServices.find((s) => s.professionalId)?.professionalId ||
        newAppointment.professionalId
      : newAppointment.professionalId;

    if (
      !newAppointment.clientId ||
      !serviceId ||
      (!selectedSuggestion && (!newAppointment.date || !newAppointment.time || !selectedProfessionalId))
    ) {
      alert(t("appointments.drawer.selectSuggestionOrDate"));
      return;
    }

    setUpdating(true);
    try {
      const totalPrice = getTotalPrice(selectedServices, services, newAppointment.serviceId);
      const totalDuration = getTotalDuration(selectedServices, services, newAppointment.serviceId);

      const appointmentData = {
        tenantId: "default", // Will be set by backend from the user's token
        clientId: newAppointment.clientId,
        serviceId: serviceId,
        professionalId: selectedProfessionalId,
        scheduledDate: newAppointment.date,
        scheduledTime: newAppointment.time,
        notes: newAppointment.notes,
        depositRequired: newAppointment.depositRequired,
        depositAmount: newAppointment.depositRequired
          ? Math.round(newAppointment.depositAmount * 100)
          : undefined,
        price: Math.round(totalPrice * 100), // Convert to cents like POS
        duration: totalDuration,
        // Commission rate (admin/owner only - only send if set)
        ...(newAppointment.commissionRate !== undefined &&
          newAppointment.commissionRate !== null && {
            commissionRate: newAppointment.commissionRate,
          }),
      };

      // Check if current user is staff and use appropriate endpoint
      const currentUser = getCurrentUser();
      const appointment =
        currentUser?.role === "staff"
          ? await apiClient.createAppointmentByStaff(appointmentData)
          : await apiClient.createAppointment(appointmentData);

      // If multiple services, create them via bulk API
      if (hasMultipleServices) {
        // Calculate start time for the appointment
        const appointmentStart = new Date(
          `${newAppointment.date}T${newAppointment.time}:00`,
        );
        let currentTime = appointmentStart.getTime();

        const servicesToCreate = resolvedSelectedServices.map((sel, index) => {
          const service = services.find((s) => s.id === sel.serviceId);
          const duration = service?.duration || 0;

          // Calculate start and end times
          const startDateTime = new Date(currentTime);
          const endDateTime = new Date(currentTime + duration * 60000);

          // Only advance current time for serial services
          if (!sel.isParallel) {
            currentTime += duration * 60000;
          }

          return {
            serviceId: sel.serviceId,
            professionalId: sel.professionalId || newAppointment.professionalId,
            isParallel: sel.isParallel,
            order: index,
            scheduledStart: startDateTime.toISOString(),
            scheduledEnd: endDateTime.toISOString(),
          };
        });

        await apiClient.bulkCreateAppointmentServices(
          appointment.id,
          servicesToCreate,
        );
      }

      // Reset form
      setNewAppointment({
        clientId: "",
        serviceId: "",
        professionalId: "",
        date: "",
        time: "",
        notes: "",
        depositRequired: false,
        depositAmount: 0,
        commissionRate: 0,
      });
      setSelectedServices([]);
      setAutoAssignMap({});
      setDateTimePreference({
        type: "next_available",
        morningPreferred: false,
        afternoonPreferred: false,
        specificDate: "",
        specificTime: "",
        specificTimePeriod: "",
      });
      clearSuggestions();

      onOpenChange(false);
      if (onAppointmentUpdated) {
        onAppointmentUpdated();
      }
    } catch (error) {
      console.error("Error creating appointment:", error);
      alert(t("appointments.drawer.failedToCreate"));
    } finally {
      setUpdating(false);
    }
  };

  // Multi-service helpers — `getTotalPrice` and `getTotalDuration` are
  // imported from ./appointment-drawer.utils. The component just
  // threads React state into them at each render.

  const handleServiceToggle = (
    serviceId: string,
    professionalId?: string,
    isParallel: boolean = false,
  ) => {
    const existing = selectedServices.find((s) => s.serviceId === serviceId);
    if (existing) {
      setSelectedServices(
        selectedServices.filter((s) => s.serviceId !== serviceId),
      );
    } else {
      setSelectedServices([
        ...selectedServices,
        {
          serviceId,
          professionalId: professionalId || undefined,
          isParallel,
        },
      ]);
    }
    setNewAppointment({
      ...newAppointment,
      serviceId: "",
      professionalId: "",
      time: "",
    });
  };

  const getStatusBadge = (status: AppointmentStatus) => {
    // CSS classes + label come from the pure helper so they're testable.
    const style = getStatusBadgeStyle(status);

    const icons: Record<string, React.ReactNode> = {
      confirmed: <CheckCircle className="w-4 h-4 mr-2" />,
      pending: <AlertCircle className="w-4 h-4 mr-2" />,
      in_progress: <Clock className="w-4 h-4 mr-2" />,
      completed: <CheckCircle className="w-4 h-4 mr-2" />,
      cancelled: <XCircle className="w-4 h-4 mr-2" />,
    };

    return (
      <span
        className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${style.bg} ${style.text} ${style.border}`}
      >
        {icons[status] ?? null}
        {style.label}
      </span>
    );
  };

  // `formatDateString` and `formatDateTimeString` are imported from
  // ./appointment-drawer.utils.

  const handleStatusChange = async (newStatus: AppointmentStatus) => {
    if (!appointment) return;

    setUpdating(true);
    try {
      await apiClient.updateAppointment(appointment!.id, {
        status: newStatus,
      } as any);
      setAppointment({ ...appointment!, status: newStatus });
    } catch (error) {
      console.error("Error updating appointment status:", error);
      alert(t("appointments.drawer.failedToUpdateStatus"));
    } finally {
      setUpdating(false);
    }
  };

  const handleEditClick = () => {
    console.log("handleEditClick called");
    console.log("Current appointment:", appointment);
    if (appointment) {
      // If appointment is completed, only allow viewing (no edit mode for services/date/time)
      // Notes can still be edited via the notes section edit button
      if (appointment.status === "completed") {
        // For completed appointments, only initialize for notes editing but don't enable full edit mode
        // Full edit mode (services, date, time) is not allowed
        console.log(
          "Appointment is completed, services/date/time cannot be edited",
        );
        return;
      }
      const editedApp = {
        ...appointment,
        date: appointment.date,
        time: appointment.time,
        notes: appointment.notes,
        service: { ...appointment.service },
        professional: { ...appointment.professional },
        addons: [...appointment.addons],
      };
      console.log("Setting editedAppointment:", editedApp);
      setEditedAppointment(editedApp);
      setCurrentAddons([...appointment.addons]);
      setEditMode(true);
    } else {
      console.error("Cannot enter edit mode: appointment is null");
    }
  };

  const handleUpdate = async () => {
    if (!appointment || !editedAppointment) return;

    setUpdating(true);
    try {
      console.log("handleUpdate called");
      console.log("Current appointment:", appointment);
      console.log("Edited appointment:", editedAppointment);
      console.log("Current addons:", currentAddons);
      console.log("notesEditMode:", notesEditMode);

      const updateData: any = {
        notes: editedAppointment.notes,
      };

      // For completed appointments in notesEditMode, only update notes
      if (notesEditMode && appointment.status === "completed") {
        console.log("Completed appointment - only updating notes");
        await apiClient.updateAppointment(appointment.id, updateData);
        console.log("Notes updated successfully");

        setAppointment({
          ...appointment!,
          notes: editedAppointment!.notes || "",
        });
        setNotesEditMode(false);
        setUpdating(false);
        return;
      }

      // Validate and format scheduledDate
      const dateValue = editedAppointment.date || appointment.date;
      const timeValue = editedAppointment.time || appointment.time;

      if (!dateValue || !timeValue) {
        console.error("Date or time is missing:", dateValue, timeValue);
        alert(t("appointments.drawer.provideDateAndTime"));
        return;
      }

      const date = new Date(`${dateValue}T${timeValue}`);
      if (isNaN(date.getTime())) {
        console.error("Invalid date or time:", dateValue, timeValue);
        alert(t("appointments.drawer.provideValidDateAndTime"));
        return;
      }
      updateData.scheduledDate = date.toISOString();
      updateData.scheduledTime = timeValue;

      if (
        editedAppointment.service &&
        editedAppointment.service.id !== appointment.service.id
      ) {
        updateData.serviceId = editedAppointment.service.id;
      }

      if (
        editedAppointment.professional &&
        editedAppointment.professional.id !== appointment.professional.id
      ) {
        updateData.professionalId = editedAppointment.professional.id;
      }

      const edited = editedAppointment as any;
      const current = appointment as any;
      if (
        edited.commissionRate !== undefined &&
        edited.commissionRate !== current.commissionRate
      ) {
        updateData.commissionRate = edited.commissionRate;
      }

      if (currentAddons && currentAddons.length > 0) {
        console.log("Adding addons to updateData:", currentAddons);
        updateData.addons = currentAddons.map((a) => ({
          addonId: a.id,
          quantity: a.quantity,
        }));
      }

      // Handle multi-service appointments - send services with professional assignments
      if (current.services && current.services.length > 0) {
        console.log(
          "Processing multi-service appointment with services:",
          current.services,
        );
        updateData.services = current.services.map((svc: any) => ({
          serviceId: svc.service?.id || svc.serviceId,
          professionalId: svc.professional?.id || svc.professionalId || null,
          isParallel: svc.isParallel || false,
        }));
        console.log("Services to update:", updateData.services);
      }

      console.log("Update data to be sent:", updateData);
      await apiClient.updateAppointment(appointment.id, updateData);
      console.log("Appointment updated successfully");

      // Record activity
      const activityEntry = {
        timestamp: new Date().toISOString(),
        action: "Appointment updated",
        details: `Updated by user. Changes: ${JSON.stringify(updateData)}`,
      };

      setAppointment((prev) =>
        prev
          ? {
              ...prev,
              activity: [...(prev.activity || []), activityEntry],
            }
          : null,
      );

      await refreshAppointment();
      setEditMode(false);
      onOpenChange(false);
      if (onAppointmentUpdated) {
        onAppointmentUpdated();
      }
    } catch (error) {
      console.error("Error updating appointment:", error);
      alert(t("appointments.drawer.failedToUpdate"));
    } finally {
      setUpdating(false);
    }
  };

  const handleServiceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    console.log("handleServiceChange called with value:", e.target.value);
    const selectedService = services.find(
      (s) => String(s.id) === e.target.value,
    );
    console.log("Selected service:", selectedService);

    setEditedAppointment((prev) => {
      if (!prev) return null;
      if (!selectedService) return prev;
      const updatedService = {
        ...prev.service,
        id: e.target.value,
        name: selectedService.name,
        price: selectedService.price || prev.service?.price || 0,
      };
      console.log("Updated service in editedAppointment:", updatedService);
      return {
        ...prev,
        service: updatedService,
      } as any;
    });
  };



  // Filter clients + handle client selection both moved to
  // ClientPickerSection in Phase 5. The orchestrator no longer
  // touches `clientSearch` / `showClientSuggestions` /
  // `filteredClients` / `handleClientSelect` directly.

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="h-full overflow-y-auto lg:w-1/2 lg:max-w-[50vw] flex flex-col">
        <DrawerHeader className="px-4 sm:px-6">
          <AppointmentHeader appointmentId={appointmentId} />
        </DrawerHeader>

        <div className="px-4 sm:px-6 pb-6 space-y-6">
          {loading ? (
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
                  setNewAppointment({
                    ...newAppointment,
                    clientId: client.id,
                  });
                }}
                onSearchClear={() => {
                  // Preserve the original behaviour: clearing the
                  // search input also invalidates the selected client
                  // so the user has to pick again. (See
                  // appointment-drawer.tsx original lines 736-742.)
                  setNewAppointment({
                    ...newAppointment,
                    clientId: "",
                  });
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
                    s.serviceId === serviceId
                      ? { ...s, isParallel }
                      : s,
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
                  // Picking from the dropdown seeds `selectedServices`
                  // so the multi-service cards view becomes available
                  // (restoring pre-refactor behavior). The service is
                  // added without overwriting an existing selection.
                  setSelectedServices((prev) => {
                    if (prev.some((s) => s.serviceId === serviceId)) {
                      return prev;
                    }
                    return [
                      ...prev,
                      { serviceId, professionalId, isParallel: false },
                    ];
                  });
                  setNewAppointment({
                    ...newAppointment,
                    serviceId,
                    professionalId,
                    time: "",
                  });
                }}
                onSingleProfessionalChange={(professionalId) => {
                  setNewAppointment({
                    ...newAppointment,
                    professionalId,
                  });
                  // Keep the seeded selectedServices entry in sync so
                  // the suggestions engine sees the right professional.
                  if (newAppointment.serviceId) {
                    setSelectedServices((prev) =>
                      prev.map((s) =>
                        s.serviceId === newAppointment.serviceId
                          ? { ...s, professionalId }
                          : s,
                      ),
                    );
                  }
                }}
                totalPrice={getTotalPrice(
                  selectedServices,
                  services,
                  newAppointment.serviceId,
                )}
                totalDuration={getTotalDuration(
                  selectedServices,
                  services,
                  newAppointment.serviceId,
                )}
                labels={{
                  services: t("appointments.services"),
                  selected: t("appointments.selected"),
                  professional: t("pos.professional"),
                  autoAssign: "Auto-assign (any available)",
                  runInParallel: t("appointments.drawer.runInParallel"),
                  selectAService: t("appointments.select_a_service"),
                  selectAProfessional: t("appointments.select_professional"),
                  totalPrice: "Total Price:",
                  totalDuration: "Total Duration:",
                  assignedTo: (name) => `Asignado a: ${name}`,
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
                  dateTimePreferences: t(
                    "appointments.date_time_preferences",
                  ),
                  selectATimePreference: t(
                    "appointments.drawer.selectATimePreference",
                  ),
                  pleaseSelectDateTime: t(
                    "appointments.drawer.pleaseSelectDateTime",
                  ),
                  nextTimeSlotAvailable: t(
                    "appointments.drawer.nextTimeSlotAvailable",
                  ),
                  todayMorning: t("appointments.drawer.todayMorning"),
                  todayAfternoon: t("appointments.drawer.todayAfternoon"),
                  flexibleTimingPreferences: t(
                    "appointments.drawer.flexibleTimingPreferences",
                  ),
                  morningPreferred: t("appointments.drawer.morningPreferred"),
                  afternoonPreferred: t(
                    "appointments.drawer.afternoonPreferred",
                  ),
                  specificDateAndTime: t(
                    "appointments.drawer.specificDateAndTime",
                  ),
                  selectDate: t("appointments.drawer.selectDate"),
                  selectTimePeriod: t("appointments.drawer.selectTimePeriod"),
                  morningAnyHour: t("appointments.drawer.morningAnyHour"),
                  eveningAnyHour: t("appointments.drawer.eveningAnyHour"),
                }}
              />

              {/* Find Available Times Button + Appointment Suggestions */}
              <AppointmentSuggestionsSection
                selectedServices={effectiveSelectedServices}
                services={services}
                professionals={professionals}
                newAppointmentDate={newAppointment.date}
                dateTimePreferenceType={dateTimePreference.type}
                appointmentSuggestions={appointmentSuggestions}
                selectedSuggestion={selectedSuggestion}
                suggestionsLoading={suggestionsLoading}
                suggestionsError={suggestionsError}
                availabilityWarnings={availabilityWarnings}
                hasSingleServiceContext={hasSingleServiceContext}
                onGenerate={() =>
                  generateAppointmentSuggestions({
                    selectedServices: effectiveSelectedServices,
                    services,
                    professionals,
                    newAppointmentDate: newAppointment.date,
                    dateTimePreference,
                    setAutoAssignMap,
                  })
                }
                onSelect={(suggestion: any) => {
                  setSelectedSuggestion(suggestion);
                  setNewAppointment({
                    ...newAppointment,
                    date: suggestion.date,
                    time: suggestion.startTime,
                  });
                }}
              />

            {/* No suggestions available */}
            {!suggestionsLoading &&
              !suggestionsError &&
              appointmentSuggestions.length === 0 &&
              selectedServices.length > 0 &&
              newAppointment.date &&
              dateTimePreference.type && (
                <div className="bg-white rounded-xl border border-gray-200 p-6 mt-4">
                  <div className="text-center py-8 text-gray-500">
                    <Calendar className="w-12 h-12 mx-auto mb-3 text-gray-400" />
                    {dateTimePreference.type === "specific" ? (
                      <>
                        <p className="font-medium text-gray-700 mb-2">
                          No availability for the specific date and time
                          requested
                        </p>
                        <p className="text-sm mb-3">
                          The exact time you selected (
                          {dateTimePreference.specificTime}) is not
                          available.
                        </p>
                        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-left max-w-md mx-auto">
                          <p className="text-sm text-blue-800 font-medium mb-1">
                            💡 Suggestions:
                          </p>
                          <ul className="text-sm text-blue-700 space-y-1">
                            <li>• Try a different time on the same date</li>
                            <li>
                              • Select "Next time slot available" for
                              automatic scheduling
                            </li>
                            <li>
                              • Choose "Today morning" or "Today afternoon"
                              for general availability
                            </li>
                          </ul>
                        </div>
                      </>
                    ) : (
                      <>
                        <p>
                          No appointment options available for the selected
                          services and preferences.
                        </p>
                        <p className="text-sm mt-1">
                          Try selecting different services or changing your
                          time preferences.
                        </p>
                      </>
                    )}
                  </div>
                </div>
              )}

            {/* Cross-booking setting status - always shown for owners/admins */}
              {currentUser?.role !== "staff" && (
                <div className="bg-white rounded-xl border border-gray-200 p-6 mb-4">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">
                    Configuración de asignación profesional
                  </h4>
                  <div
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      allowProfessionalCrossBooking
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {allowProfessionalCrossBooking ? (
                      <>
                        <span className="w-1.5 h-1.5 bg-green-400 rounded-full mr-1.5"></span>
                        Los profesionales pueden asignar citas a otros
                      </>
                    ) : (
                      <>
                        <span className="w-1.5 h-1.5 bg-gray-400 rounded-full mr-1.5"></span>
                        Los profesionales solo pueden asignarse a sí mismos
                      </>
                    )}
                  </div>
                </div>
              )}





              {/* Notes */}
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  Notes
                </h3>
                <textarea
                  value={newAppointment.notes}
                  onChange={(e) =>
                    setNewAppointment({
                      ...newAppointment,
                      notes: e.target.value,
                    })
                  }
                  rows={3}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                  placeholder={t("appointments.additional_notes")}
                />
              </div>

              {/* Deposit Payment Section */}
              <div className="border-t pt-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">
                  {t("appointments.deposit_payment")}
                </h3>
                <div className="space-y-4">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      checked={newAppointment.depositRequired}
                      onChange={(e) =>
                        setNewAppointment({
                          ...newAppointment,
                          depositRequired: e.target.checked,
                        })
                      }
                      className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                    />
                    <span className="ml-2 text-gray-700">
                      {t("appointments.require_deposit")}
                    </span>
                  </label>

                  {newAppointment.depositRequired && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t("appointments.deposit_amount")}
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={newAppointment.depositAmount}
                        onChange={(e) =>
                          setNewAppointment({
                            ...newAppointment,
                            depositAmount: parseFloat(e.target.value) || 0,
                          })
                        }
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                        placeholder={t(
                          "appointments.deposit_amount_placeholder",
                        )}
                      />
                      <p className="text-sm text-gray-500 mt-1">
                        Customer will pay this amount now to confirm the booking
                      </p>
                    </div>
                  )}
                </div>

                {/* Commission Rate (Admin/Owner only) */}
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("appointments.commission_rate")} (%)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={newAppointment.commissionRate}
                    onChange={(e) =>
                      setNewAppointment({
                        ...newAppointment,
                        commissionRate: parseInt(e.target.value) || 0,
                      })
                    }
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    placeholder={t("appointments.leave_empty_default_rate")}
                  />
                  <p className="text-sm text-gray-500 mt-1">
                    {t("appointments.commission_rate_description")}
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  {t("appointments.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleCreateAppointment}
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
                      {selectedServices.length > 0 && `(€${getTotalPrice(selectedServices, services, newAppointment.serviceId)})`}
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : appointment ? (
            <div>
              {/* Status and Actions Bar — extracted to EditModeActions */}
              <EditModeActions
                appointment={appointment}
                editMode={editMode}
                notesEditMode={notesEditMode}
                updating={updating}
                onEnterEdit={handleEditClick}
                onCancelEdit={() => {
                  setEditMode(false);
                  setEditedAppointment(null);
                }}
                onSave={handleUpdate}
                onStatusChange={handleStatusChange}
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
                }}
              />

              {/* Main Content */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Left Column - Appointment Info */}
                <div className="lg:col-span-2 space-y-6">
                  {/* Date & Time Card — extracted to ScheduleCard (Phase 5c.3) */}
                  <ScheduleCard
                    appointment={appointment}
                    editMode={editMode}
                    editedDate={editedAppointment?.date || appointment.date}
                    editedTime={editedAppointment?.time || appointment.time}
                    onEnterEditMode={() => setEditMode(true)}
                    onDateChange={(date) =>
                      setEditedAppointment({
                        ...editedAppointment,
                        date,
                      } as any)
                    }
                    onTimeChange={(time) =>
                      setEditedAppointment({
                        ...editedAppointment,
                        time,
                      } as any)
                    }
                    labels={{
                      schedule: t("appointments.schedule"),
                      date: t("appointments.date"),
                      time: t("appointments.time"),
                    }}
                  />

                  {/* Service Card — extracted to ServiceCard (Phase 5c.4) */}
                  <ServiceCard
                    appointment={appointment}
                    editedAppointment={editedAppointment}
                    editMode={editMode}
                    services={services}
                    professionals={professionals}
                    selectedAddon={selectedAddon}
                    onEnterEditMode={() => setEditMode(true)}
                    onServiceChange={(id) =>
                      handleServiceChange({
                        target: { value: id },
                      } as React.ChangeEvent<HTMLSelectElement>)
                    }
                    onRemoveService={(index) => {
                      const updatedServices =
                        appointment?.services?.filter((_, i) => i !== index);
                      setAppointment((prev) =>
                        prev
                          ? { ...prev, services: updatedServices }
                          : null,
                      );
                    }}
                    onUpdateProfessional={(index, professionalId) => {
                      const selectedProf = professionals.find(
                        (p) => String(p.id) === professionalId,
                      );
                      setAppointment((prev) => {
                        if (!prev) return null;
                        const updatedServices = prev.services?.map((svc, i) => {
                          if (i === index) {
                            return {
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
                            };
                          }
                          return svc;
                        });
                        return {
                          ...prev,
                          services: updatedServices,
                        };
                      });
                    }}
                    onSelectedAddonChange={setSelectedAddon}
                    onAddService={() => {
                      const service = services.find(
                        (s) => String(s.id) === selectedAddon,
                      );
                      if (service) {
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
                          prev
                            ? {
                                ...prev,
                                services: [
                                  ...(prev.services || []),
                                  newService,
                                ],
                              }
                            : null,
                        );
                        setSelectedAddon("");
                      }
                    }}
                    labels={{
                      services: t("appointments.services"),
                      parallel: t("appointments.parallel"),
                      selectProfessional: t("appointments.select_professional"),
                      addMoreServices: t("appointments.add_more_services"),
                      selectServiceToAdd: t("appointments.select_service_to_add"),
                      add: t("appointments.add"),
                    }}
                  />

                  {/* Add-ons — extracted to AddonsCard (Phase 5c.5) */}
                  <AddonsCard
                    appointment={appointment}
                    editMode={editMode}
                    currentAddons={currentAddons}
                    services={services}
                    selectedAddon={selectedAddon}
                    addonQuantity={addonQuantity}
                    editedServiceId={
                      editedAppointment && "service" in editedAppointment
                        ? (editedAppointment.service as any)?.id
                        : undefined
                    }
                    onSelectedAddonChange={setSelectedAddon}
                    onAddonQuantityChange={setAddonQuantity}
                    onAddAddon={() => {
                      const service = services.find(
                        (s) => String(s.id) === selectedAddon,
                      );
                      if (service) {
                        const newAddon = {
                          id: service.id,
                          name: service.name,
                          quantity: addonQuantity,
                          price: Number(service.price) || 0,
                          duration: Number(service.duration) || 0,
                        };
                        setCurrentAddons((prev) => [...prev, newAddon]);
                        setSelectedAddon("");
                        setAddonQuantity(1);
                      }
                    }}
                    onRemoveAddon={(index) =>
                      setCurrentAddons((prev) =>
                        prev.filter((_, i) => i !== index),
                      )
                    }
                    labels={{
                      addOns: t("appointments.add_ons"),
                      selectAddOn: t("appointments.select_add_on"),
                      add: t("appointments.add"),
                      quantity: t("appointments.common.quantity"),
                    }}
                  />

                  {/* Service Timeline - Show for multi-service appointments */}
                  {appointment.services && appointment.services.length > 1 && (
                    <div className="bg-white rounded-xl border border-gray-200 p-6">
                      <ServiceTimeline
                        timezone={timezone}
                        services={(() => {
                          // Calculate scheduled times for services that don't have them
                          // Create appointment start time - ensure we work in local time
                          const [hours, minutes] = appointment.time.split(':').map(Number);
                          const appointmentDate = new Date(appointment.date);
                          appointmentDate.setHours(hours, minutes, 0, 0);
                          let currentTime = appointmentDate.getTime();

                          return appointment.services.map((svc, index) => {
                            const duration = svc.service?.duration || 0;

                            // Use existing scheduled times if available, otherwise calculate
                            let scheduledStart: string;
                            let scheduledEnd: string;

                            if (svc.scheduledStart && svc.scheduledEnd) {
                              scheduledStart = svc.scheduledStart;
                              scheduledEnd = svc.scheduledEnd;
                            } else {
                              // Calculate based on appointment start time and service order
                              const startDate = new Date(currentTime);
                              const endDate = new Date(
                                currentTime + duration * 60000,
                              );

                              // Validate dates before converting to ISO string
                              if (
                                isNaN(startDate.getTime()) ||
                                isNaN(endDate.getTime())
                              ) {
                                // Fallback to current time if date is invalid
                                const now = new Date();
                                scheduledStart = now.toISOString();
                                scheduledEnd = new Date(
                                  now.getTime() + duration * 60000,
                                ).toISOString();
                              } else {
                                scheduledStart = startDate.toISOString();
                                scheduledEnd = endDate.toISOString();
                              }

                              // Only advance current time for serial services
                              if (!svc.isParallel) {
                                currentTime += duration * 60000;
                              }
                            }

                            return {
                              id: svc.id || `temp-${index}`,
                              serviceId: svc.service?.id || "",
                              serviceName: svc.service?.name || "Service",
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
                        editable={
                          editMode && appointment.status !== "completed"
                        }
                        onReorder={async (reorderedServices) => {
                          if (!appointment) return;
                          try {
                            const serviceOrders = reorderedServices.map(
                              (svc, index) => ({
                                serviceId: svc.serviceId,
                                order: index,
                              }),
                            );
                            await apiClient.reorderAppointmentServices(
                              appointment.id,
                              serviceOrders,
                            );
                            // Refresh appointment data
                            await refreshAppointment();
                          } catch (error) {
                            console.error("Error reordering services:", error);
                            alert(t("appointments.drawer.failedToReorderServices"));
                          }
                        }}
                        onTimeChange={async (
                          serviceId,
                          scheduledStart,
                          scheduledEnd,
                        ) => {
                          try {
                            await apiClient.updateAppointmentServiceTiming(
                              serviceId,
                              scheduledStart,
                              scheduledEnd,
                            );
                            // Refresh appointment data
                            await refreshAppointment();
                          } catch (error) {
                            console.error(
                              "Error updating service timing:",
                              error,
                            );
                            alert(t("appointments.drawer.failedToUpdateServiceTiming"));
                          }
                        }}
                        onModeToggle={async (serviceId, isParallel) => {
                          try {
                            await apiClient.toggleAppointmentServiceMode(
                              serviceId,
                              isParallel,
                            );
                            // Refresh appointment data
                            await refreshAppointment();
                          } catch (error) {
                            console.error(
                              "Error toggling service mode:",
                              error,
                            );
                            alert(t("appointments.drawer.failedToToggleServiceMode"));
                          }
                        }}
                      />
                    </div>
                  )}

                  {/* Client Card */}
                  <div className="bg-white rounded-xl border border-gray-200 p-6">
                    <div className="flex items-center justify-between mb-4">
                      <h2 className="text-lg font-semibold text-gray-900">
                        {t("appointments.client")}
                      </h2>
                      <a
                        href={`/dashboard/clients/${appointment.client.id}`}
                        className="text-sm text-indigo-600 hover:text-indigo-700"
                      >
                        {t("appointments.view_profile")}
                      </a>
                    </div>
                    <div className="flex items-start space-x-4">
                      <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center">
                        <User className="w-6 h-6 text-indigo-600" />
                      </div>
                      <div className="flex-1">
                        <h3 className="font-semibold text-gray-900">
                          {appointment.client.name}
                        </h3>
                        <div className="mt-2 space-y-2">
                          <a
                            href={`mailto:${appointment.client.email}`}
                            className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                          >
                            <Mail className="w-4 h-4 mr-2 text-gray-400" />
                            {appointment.client.email}
                          </a>
                          <a
                            href={`tel:${appointment.client.phone}`}
                            className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                          >
                            <Phone className="w-4 h-4 mr-2 text-gray-400" />
                            {appointment.client.phone}
                          </a>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Professional Card - Hide for multi-service appointments (professionals shown per service) */}
                  {(!appointment.services ||
                    appointment.services.length === 0) && (
                    <div className="bg-white rounded-xl border border-gray-200 p-6">
                      <div className="flex items-center justify-between mb-4">
                        <h2 className="text-lg font-semibold text-gray-900">
                          {t("appointments.professional")}
                        </h2>
                        {editMode ? (
                          <select
                            value={
                              editedAppointment?.professional?.id ||
                              appointment.professional.id
                            }
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
                                    ...prev.professional,
                                    id: e.target.value,
                                    name: `${selectedProfessional.firstName} ${selectedProfessional.lastName}`,
                                  },
                                } as any;
                              });
                            }}
                            className="border border-gray-300 rounded px-2 py-1 text-sm"
                          >
                            {professionals
                              .filter((prof) =>
                                prof.services?.some(
                                  (ps) =>
                                    ps.serviceId ===
                                    (editedAppointment?.service?.id ||
                                      appointment.service.id),
                                ),
                              )
                              .map((professional) => (
                                <option
                                  key={professional.id}
                                  value={professional.id}
                                >
                                  {professional.firstName}{" "}
                                  {professional.lastName}
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
                        <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                          <User className="w-6 h-6 text-green-600" />
                        </div>
                        <div className="flex-1">
                          <h3 className="font-semibold text-gray-900">
                            {editMode && editedAppointment?.professional?.name
                              ? editedAppointment.professional.name
                              : appointment.professional.name}
                          </h3>
                          <span className="inline-block px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded-full mt-1">
                            {appointment.professional.specialty}
                          </span>
                          <div className="mt-2 space-y-2">
                            <a
                              href={`mailto:${appointment.professional.email}`}
                              className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                            >
                              <Mail className="w-4 h-4 mr-2 text-gray-400" />
                              {appointment.professional.email}
                            </a>
                            <a
                              href={`tel:${appointment.professional.phone}`}
                              className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                            >
                              <Phone className="w-4 h-4 mr-2 text-gray-400" />
                              {appointment.professional.phone}
                            </a>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  {/* Show info for multi-service appointments */}
                  {appointment.services && appointment.services.length > 0 && (
                    <div className="bg-white rounded-xl border border-gray-200 p-6">
                      <h2 className="text-lg font-semibold text-gray-900 mb-2">
                        {t("appointments.professionals")}
                      </h2>
                      <p className="text-sm text-gray-600">
                        {t("appointments.professionals_description")}
                      </p>
                    </div>
                  )}
                </div>

                {/* Right Column - Sidebar */}
                <div className="space-y-6">
                  {/* Payment Summary */}
                  <div className="bg-white rounded-xl border border-gray-200 p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                      {t("appointments.payment_summary")}
                    </h2>
                    <div className="space-y-3">
                      {/* Multi-service prices */}
                      {appointment.services &&
                      appointment.services.length > 0 ? (
                        <>
                          {appointment.services.map((appService, index) => (
                            <div
                              key={appService.id || index}
                              className="flex items-center justify-between text-sm"
                            >
                              <span className="text-gray-600">
                                {appService.service?.name || "Service"}{" "}
                                {appService.isParallel &&
                                  `(${t("appointments.parallel")})`}
                              </span>
                              <span className="font-medium text-gray-900">
                                $
                                {(
                                  Number(appService.service?.price) || 0
                                ).toFixed(2)}
                              </span>
                            </div>
                          ))}
                        </>
                      ) : (
                        /* Single service fallback */
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-600">
                            {t("appointments.service")}
                          </span>
                            <span className="font-medium text-gray-900">
                            $
                            {(
                              Number(
                                editMode && editedAppointment?.service?.price !== undefined
                                  ? editedAppointment.service.price
                                  : appointment.service.price,
                              ) || 0
                            ).toFixed(2)}
                          </span>
                        </div>
                      )}
                      {(editMode ? currentAddons : appointment.addons)?.map(
                        (addon) => (
                          <div
                            key={addon.id}
                            className="flex items-center justify-between text-sm"
                          >
                            <span className="text-gray-600">
                              {addon.name} x{addon.quantity}
                            </span>
                            <span className="font-medium text-gray-900">
                              $
                              {(
                                (Number(addon.price) || 0) *
                                (Number(addon.quantity) || 0)
                              ).toFixed(2)}
                            </span>
                          </div>
                        ),
                      )}
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-600">
                          {t("appointments.duration")}
                        </span>
                        <span className="font-medium text-gray-900">
                          {calculateTotalDuration(appointment)} min
                        </span>
                      </div>
                      <div className="border-t border-gray-200 pt-3">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-gray-900">
                            {t("appointments.total")}
                          </span>
                          <span className="text-xl font-bold text-gray-900">
                            $
                            {(() => {
                              if (!editMode) {
                                // Multi-service total
                                if (
                                  appointment.services &&
                                  appointment.services.length > 0
                                ) {
                                  const servicesTotal =
                                    appointment.services.reduce(
                                      (sum, s) =>
                                        sum + (Number(s.service?.price) || 0),
                                      0,
                                    );
                                  const addonsSum =
                                    appointment.addons?.reduce(
                                      (sum, addon) =>
                                        sum +
                                        (Number(addon.price) || 0) *
                                          (Number(addon.quantity) || 0),
                                      0,
                                    ) || 0;
                                  return (servicesTotal + addonsSum).toFixed(2);
                                }
                                // Single service total
                                const basePrice =
                                  Number(appointment.service.price) || 0;
                                const addonsSum = appointment.addons.reduce(
                                  (sum, addon) =>
                                    sum +
                                    (Number(addon.price) || 0) *
                                      (Number(addon.quantity) || 0),
                                  0,
                                );
                                return (basePrice + addonsSum).toFixed(2);
                              }
                              const basePrice =
                                Number(
                                  editedAppointment?.service?.price !== undefined
                                    ? editedAppointment.service.price
                                    : appointment.service.price,
                                ) || 0;
                              const currentAddonsSum = currentAddons.reduce(
                                (sum, addon) =>
                                  sum +
                                  (Number(addon.price) || 0) *
                                    (Number(addon.quantity) || 0),
                                0,
                              );
                              return (basePrice + currentAddonsSum).toFixed(2);
                            })()}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Notes — extracted to NotesCard (Phase 5c.2) */}
                  <NotesCard
                    appointment={appointment}
                    editMode={editMode}
                    notesEditMode={notesEditMode}
                    editedNotes={editedAppointment?.notes || appointment.notes}
                    onEnterEditMode={() => {
                      // If appointment is completed, only allow notes editing
                      if (appointment.status === "completed") {
                        setNotesEditMode(true);
                        // Initialize editedAppointment with current notes
                        setEditedAppointment(
                          (prev) =>
                            prev || {
                              ...appointment,
                              notes: appointment.notes,
                            },
                        );
                      } else {
                        setEditMode(true);
                      }
                    }}
                    onCancelEdit={() => {
                      setEditMode(false);
                      setNotesEditMode(false);
                    }}
                    onNotesChange={(notes) =>
                      setEditedAppointment({
                        ...editedAppointment,
                        notes,
                      } as any)
                    }
                    labels={{
                      notes: t("appointments.notes"),
                      cancel: t("appointments.cancel"),
                      noNotesForAppointment: t(
                        "appointments.no_notes_for_appointment",
                      ),
                    }}
                  />

                  {/* Commission Rate (Admin/Owner only) */}
                  <div className="bg-white rounded-xl border border-gray-200 p-6">
                    <h2 className="text-lg font-semibold text-gray-900 mb-4">
                      {t("appointments.commission_rate")}
                    </h2>
                    {editMode ? (
                      <div>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={
                            (editedAppointment as any)?.commissionRate ?? ""
                          }
                          onChange={(e) =>
                            setEditedAppointment({
                              ...editedAppointment,
                              commissionRate: e.target.value
                                ? parseInt(e.target.value)
                                : undefined,
                            } as any)
                          }
                          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                          placeholder={t(
                            "appointments.leave_empty_default_rate",
                          )}
                        />
                        <p className="text-sm text-gray-500 mt-1">
                          {t("appointments.commission_rate_description")}
                        </p>
                      </div>
                    ) : appointment.commissionRate !== undefined &&
                      appointment.commissionRate !== null ? (
                      <div>
                        <p className="text-lg font-medium text-indigo-600">
                          {appointment.commissionRate}%
                        </p>
                        <p className="text-sm text-gray-500">
                          Custom rate for this appointment
                        </p>
                      </div>
                    ) : (
                      <div>
                        <p className="text-lg font-medium text-gray-400">
                          {t("appointments.using_professional_default")}
                        </p>
                        <p className="text-sm text-gray-500">
                          {t("appointments.no_custom_rate_set")}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Activity Timeline */}
                  <ActivitySection
                    appointment={appointment}
                    activityLoading={activityLoading}
                    onToggle={refreshActivity}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center py-8">
              <p className="text-gray-500">{t("appointments.drawer.notFound")}</p>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
