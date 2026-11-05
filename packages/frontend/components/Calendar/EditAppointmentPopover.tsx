import React, { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Search, CheckCircle, Loader2, Zap, Euro, Percent, Ban } from "lucide-react";
import { Professional } from "./types";
import apiClient from "../../lib/api";
import { getCurrentUser } from "../../lib/utils";
import { Appointment } from "./types";
import { salonInstant, salonTime } from "./salon-time";
import { useSalonTimeZone } from "./SalonTimeZone";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";
import {
  salonTermsForm,
  salonTermsInvalid,
  salonTermsUpdate,
} from "../../app/dashboard/appointments/components/appointment-drawer.utils";
import { LocationSelect } from "./LocationSelect";
import { useBookingLocations } from "@/lib/use-booking-locations";
import {
  currentLocationOf,
  hasLocations,
  locationForEdit,
  locationsOfProfessional,
} from "@/lib/panel-booking-locations";

interface ClientOption {
  id: string;
  name: string;
  email?: string;
  phone?: string;
}

interface ServiceOption {
  id: string;
  name: string;
  duration: number;
  price: number;
  isActive: boolean;
}

interface EditAppointmentPopoverProps {
  appointmentId: string;
  professionals: Professional[];
  onClose: () => void;
  onSuccess: () => void;
}

export const EditAppointmentPopover: React.FC<EditAppointmentPopoverProps> = ({
  appointmentId,
  professionals,
  onClose,
  onSuccess,
}) => {
  const timeZone = useSalonTimeZone();
  const t = useTranslations();
  const { toast } = useToast();
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [services, setServices] = useState<ServiceOption[]>([]);
  const [appointmentData, setAppointmentData] = useState<Appointment | null>(null);
  // The appointment's own day and time on the salon's clock, sent back as
  // they are: this form does not move it.
  const [when, setWhen] = useState<{ day: string; time: string } | null>(null);
  const [clientId, setClientId] = useState("");
  const [serviceId, setServiceId] = useState("");
  // The service the appointment had when opened: still offered here if it
  // has since been deactivated, so the form does not silently change it.
  const [loadedServiceId, setLoadedServiceId] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [showClientSuggestions, setShowClientSuggestions] = useState(false);
  const [notes, setNotes] = useState("");
  const [depositRequired, setDepositRequired] = useState(false);
  // Euros as typed; the server stores cents.
  const [depositAmount, setDepositAmount] = useState("");
  // Empty: the professional's usual rate; "0" is a real 0 %.
  const [commissionRate, setCommissionRate] = useState("");
  // The terms as loaded, so a save sends only what changed.
  const [termsBefore, setTermsBefore] = useState<Parameters<typeof salonTermsUpdate>[0]["before"]>({});
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [deleting, setDeleting] = useState(false);
  // Cancelling is confirmed in the panel's dialog. It is portalled to <body>
  // (the popover is translated, which would trap a fixed overlay), so a click
  // in it must not count as a click outside the popover.
  const [confirmCancel, setConfirmCancel] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const clientSearchRef = useRef<HTMLDivElement>(null);

  const professional = professionals.find((p) => p.id === appointmentData?.professionalId);

  // Multi-local: where it is, and a picker when its professional works at
  // several locations. Another professional is a drag on the agenda (the
  // server keeps the location if they work there, else takes theirs).
  const bookingLocations = useBookingLocations();
  const [loadedLocationId, setLoadedLocationId] = useState<string | null>(null);
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const locationBefore = currentLocationOf(bookingLocations, {
    locationId: loadedLocationId,
    professionalId: appointmentData?.professionalId,
  });
  const locationId = locationChoice ?? locationBefore;
  const theirLocations = locationsOfProfessional(bookingLocations, appointmentData?.professionalId).locationIds;

  const filteredClients = useMemo(() => {
    if (!clientSearch) return [];
    const q = clientSearch.toLowerCase();
    return clients.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.email && c.email.toLowerCase().includes(q)) ||
        (c.phone && c.phone.includes(q))
    );
  }, [clientSearch, clients]);

  useEffect(() => {
    const fetchAppointment = async () => {
       try {
         setFetching(true);
         const apiAppointment = await apiClient.getAppointment(appointmentId);
         
         // It was fetched and never kept, so the form sat on "Loading..."
         // for good. Its start is read on the salon's clock, as the grid's.
         const day = apiAppointment.scheduledDate.slice(0, 10);
         const start = salonInstant(day, apiAppointment.scheduledTime, timeZone);
         setWhen({ day, time: apiAppointment.scheduledTime });
         setAppointmentData({
           id: apiAppointment.id,
           appointmentId: apiAppointment.id,
           professionalId: apiAppointment.professionalId,
           start: start.toISOString(),
           end: new Date(start.getTime() + (apiAppointment.duration || 0) * 60_000).toISOString(),
           type: "appointment",
           status: apiAppointment.status,
         });

         // Set form fields directly from API response (it has all the fields we need)
         setClientId(apiAppointment.clientId || "");
         setServiceId(apiAppointment.serviceId || "");
         setLoadedServiceId(apiAppointment.serviceId || "");
         setLoadedLocationId(apiAppointment.locationId ?? null);
         
// Set additional fields - handle undefined values from API.
         // These three fields (depositRequired/depositAmount/commissionRate)
         // are part of the Calendar `Appointment` shape but live on the
         // backend response under optional extensions; cast through `any`
         // so the form can read them if the backend supplies them.
         setNotes(apiAppointment.notes ?? "");
         // The deposit comes in cents: a 20 € deposit showed as "2000" in a
         // euros field, and typing 25 there saved 25 cents. A 0 % override
         // showed as 0 and was then dropped on save.
         const loaded = apiAppointment as any;
         const terms = salonTermsForm(loaded);
         setDepositRequired(terms.depositRequired);
         setDepositAmount(terms.deposit);
         setCommissionRate(terms.commission);
         setTermsBefore({
           commissionRate: loaded.commissionRate,
           depositRequired: loaded.depositRequired,
           depositAmount: loaded.depositAmount,
         });
       } catch (err) {
         console.error("Error fetching appointment for edit:", err);
         toast({
           title: t("appointments.calendarView.loadAppointmentFailed"),
           description: err instanceof Error && err.message ? err.message : undefined,
           variant: "destructive",
         });
       } finally {
         setFetching(false);
       }
    };
    
    const fetchData = async () => {
      try {
        const [clientsData, servicesData] = await Promise.all([
          apiClient.getClients(),
          apiClient.getServices(),
        ]);

        const mappedClients = (clientsData as any[]).map((c: any) => ({
          id: c.id,
          name: `${c.firstName} ${c.lastName}`,
          email: c.email,
          phone: c.phone,
        }));
        setClients(mappedClients);

        const rawServices = (servicesData as any).data || servicesData;
        const mappedServices = (rawServices as any[]).map((s: any) => ({
          id: s.id,
          name: s.name,
          duration: s.duration,
          price: s.price,
          isActive: s.isActive !== false,
        }));
        setServices(mappedServices);
      } catch (err) {
        console.error("Error fetching data for edit popover:", err);
      }
    };

    fetchAppointment();
    fetchData();
    // Not the professionals (only read to show a name): each calendar refresh
    // hands a new array, which refetched the appointment and reset the form.
    // Not t/toast either: t is a new function on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId, timeZone]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (confirmCancel) return;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose, confirmCancel]);

  const handleClientSelect = (client: ClientOption) => {
    setClientId(client.id);
    setClientSearch(client.name);
    setShowClientSuggestions(false);
  };

  const performCancel = async () => {
    setDeleting(true);
    try {
      await apiClient.cancelAppointment(appointmentId);
      onSuccess();
    } catch (err) {
      console.error("Error cancelling appointment:", err);
      toast({
        title: t("appointments.calendarView.cancelFailed"),
        description: err instanceof Error && err.message ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
      setConfirmCancel(false);
    }
  };

  const handleSubmit = async () => {
    if (!clientId || !serviceId) return;
    const terms = { commission: commissionRate, depositRequired, deposit: depositAmount };
    if (salonTermsInvalid(terms)) {
      toast({ title: t("appointments.drawer.invalidTerms"), variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const appointment = appointmentData!;
      const dateStr = when!.day;
      const timeStr = when!.time;

      const currentUser = getCurrentUser();
      const updateData: Partial<{
        clientId: string;
        serviceId: string;
        professionalId: string;
        scheduledDate: string;
        scheduledTime: string;
        notes?: string;
        depositRequired?: boolean;
        depositAmount?: number;
        commissionRate?: number | null;
        locationId?: string;
      }> = {
        clientId,
        serviceId,
        professionalId: appointment.professionalId,
        scheduledDate: dateStr,
        scheduledTime: timeStr,
        // Always sent: an emptied field clears the notes.
        notes,
        // Only what changed, deposit in cents, a cleared override as null;
        // nothing from a professional (the server ignores it).
        ...salonTermsUpdate({ role: currentUser?.role, before: termsBefore, form: terms }),
      };
      // Only when moved to another of the professional's locations.
      const movedTo = locationForEdit(bookingLocations, locationBefore, locationId);
      if (movedTo) updateData.locationId = movedTo;

      if (currentUser?.role === "staff") {
        await apiClient.updateAppointment(appointmentId, updateData);
      } else {
        await apiClient.updateAppointment(appointmentId, updateData);
      }

      onSuccess();
    } catch (err) {
      // It used to say nothing: the server's reason never reached the owner.
      console.error("Error updating appointment:", err);
      toast({
        title: t("appointments.calendarView.updateFailed"),
        description: err instanceof Error && err.message ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  // At the top of what is visible of the calendar, not level with the slot:
  // the grid scrolls inside the calendar, and a slot low in the day put the
  // popover below the box.
  return (
    <div className="absolute inset-0 z-30 pointer-events-none">
      <div
        ref={popoverRef}
        className="absolute top-2 left-1/2 -translate-x-1/2 w-96 max-w-[calc(100%-1rem)] max-h-[calc(100%-1rem)] overflow-y-auto bg-background border border-border rounded-lg shadow-xl p-4 pointer-events-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm">
            {appointmentData
              ? t("appointments.calendarView.editTitle")
              : t("appointments.calendarView.loadingAppointment")}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setConfirmCancel(true)}
              disabled={deleting || fetching || !appointmentData}
              className="inline-flex items-center gap-1 px-2 py-1 text-sm border border-border rounded-md hover:bg-red-50 hover:text-red-600 disabled:opacity-50 transition-colors"
            >
              <Ban className="w-3 h-3" />
              {t("appointments.calendarView.cancelAppointment")}
            </button>
            <button
              onClick={onClose}
              aria-label={t("appointments.calendarView.close")}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {fetching || !appointmentData ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground mb-3">
              {professional?.name} • {salonTime(appointmentData.start, timeZone)}
            </div>

            <div className="space-y-3">
              {hasLocations(bookingLocations) && theirLocations.length > 1 && (
                <div>
                  <label className="block text-xs font-medium mb-1">{t("appointments.locations.label")}</label>
                  <LocationSelect
                    data={bookingLocations}
                    value={locationId}
                    only={theirLocations}
                    label={t("appointments.locations.label")}
                    onChange={setLocationChoice}
                    className="w-full px-3 py-1.5 text-sm border border-border rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-background"
                  />
                </div>
              )}
              <div ref={clientSearchRef}>
                <label className="block text-xs font-medium mb-1">{t("appointments.client")}</label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="text"
                    value={clientSearch}
                    onChange={(e) => {
                      setClientSearch(e.target.value);
                      setShowClientSuggestions(true);
                      if (!e.target.value) {
                        setClientId("");
                      }
                    }}
                    onFocus={() => setShowClientSuggestions(true)}
                    className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-background"
                    placeholder={t("appointments.calendarView.searchClient")}
                  />
                </div>
                {showClientSuggestions && clientSearch && (
                  <div className="absolute z-40 w-80 mt-1 bg-background border border-border rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {filteredClients.length === 0 ? (
                      <div className="px-3 py-2 text-muted-foreground text-xs">
                        {t("appointments.no_clients_found")}
                      </div>
                    ) : (
                      filteredClients.map((client) => (
                        <button
                          key={client.id}
                          type="button"
                          onClick={() => handleClientSelect(client)}
                          className={`w-full px-3 py-2 text-left hover:bg-accent transition-colors text-sm ${
                            clientId === client.id ? "bg-accent" : ""
                          }`}
                        >
                          <div className="font-medium">{client.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {client.email && <span>{client.email}</span>}
                            {client.email && client.phone && <span> • </span>}
                            {client.phone && <span>{client.phone}</span>}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
                {clientId && (
                  <div className="mt-1 flex items-center text-xs text-green-600">
                    <CheckCircle className="w-3 h-3 mr-1" />
                    {t("appointments.client_selected")}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">{t("appointments.service")}</label>
                <select
                  value={serviceId}
                  onChange={(e) => setServiceId(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-background"
                >
                  <option value="">{t("appointments.calendarView.selectService")}</option>
                  {services
                    .filter((service) => service.isActive || service.id === loadedServiceId)
                    .map((service) => (
                    <option key={service.id} value={service.id}>
                      {t("appointments.calendarView.serviceOption", { name: service.name, minutes: service.duration })}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={handleSubmit}
                  disabled={!clientId || !serviceId || loading}
                  className="flex-1 px-3 py-1.5 text-sm font-medium bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                >
                  {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t("appointments.calendarView.saveChanges")}
                </button>
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-accent transition-colors"
                >
                  {t("appointments.calendarView.cancel")}
                </button>
              </div>
            </div>

              {/* Notes Section */}
              <div className="border-t pt-4 mt-4">
                <label className="block text-xs font-medium mb-1">
                  <Search className="w-4 h-4 mr-1 text-indigo-600" />
                  {t("appointments.notes")}
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-background"
                  placeholder={t("appointments.calendarView.notesPlaceholder")}
                />
              </div>

            {/* Deposit Payment Section */}
            <div className="border-t pt-4 mt-4">
              <label className="block text-xs font-medium mb-1 flex items-center">
                <Euro className="w-4 h-4 mr-1 text-indigo-600" />
                {t("appointments.deposit_payment")}
              </label>
              <div className="space-y-2">
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={depositRequired}
                    onChange={(e) => setDepositRequired(e.target.checked)}
                    className="w-3 h-3 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                  />
                  <span className="ml-2 text-xs text-gray-700">
                    {t("appointments.require_deposit")}
                  </span>
                </label>

                {depositRequired && (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      {t("appointments.deposit_amount")}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      className="w-full px-3 py-1.5 text-sm border border-border rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-background"
                      placeholder="0.00"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      {t("appointments.calendarView.depositHint")}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Commission Rate (Admin/Owner only) */}
            <div className="border-t pt-4 mt-4">
              <label className="block text-xs font-medium mb-1 flex items-center">
                <Percent className="w-4 h-4 mr-1 text-indigo-600" />
                {t("appointments.commission_rate")} (%)
              </label>
              <div className="space-y-2">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={commissionRate}
                  onChange={(e) => setCommissionRate(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-md focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-background"
                  placeholder={t("appointments.calendarView.commissionPlaceholder")}
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t("appointments.calendarView.commissionHint")}
                </p>
              </div>
            </div>
          </>
        )}

        {/* Rendered inside the popover so React clicks still stop at its
            stopPropagation, but portalled so the overlay covers the page. */}
        {confirmCancel &&
          createPortal(
            <ConfirmDialog
              open
              title={t("appointments.calendarView.cancelConfirmTitle")}
              description={t("appointments.calendarView.cancelConfirmDescription")}
              confirmLabel={t("appointments.calendarView.cancelAppointment")}
              cancelLabel={t("appointments.calendarView.keepAppointment")}
              destructive
              loading={deleting}
              onCancel={() => setConfirmCancel(false)}
              onConfirm={performCancel}
            />,
            document.body,
          )}
      </div>
    </div>
  );
};
