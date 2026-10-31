import { useEffect, useRef, useState } from "react";
import apiClient from "../../../../../../lib/api";
import {
  mergeActivity,
  serverMessage,
  toDrawerAppointment,
  transformAddons,
} from "../../appointment-drawer.utils";
import type { Appointment } from "../types";

/**
 * Loads the appointment being viewed/edited and its activity feed. Owns:
 *   - `appointment`, `loading`, `loadError`, `editedAppointment`,
 *     `currentAddons`, `activityLoading` state
 *   - the fetch when the drawer opens on an appointment, or the agenda asks
 *     for a refresh (`refreshKey`) -- the only fetch: the drawer used to
 *     fetch again on open, so every opening asked twice
 *   - the `useEffect` that initialises `editedAppointment` when entering
 *     edit mode
 *   - the `useEffect` that resolves raw add-ons once services load
 *
 * Switching quickly between appointments could show the previous one: two
 * requests in flight, and whichever answered last won. Every request now
 * carries a number, and only the newest one's answer (or error) lands; the
 * previous appointment is dropped as soon as another is asked for.
 */

export interface UseAppointmentDataResult {
  appointment: Appointment | null;
  setAppointment: React.Dispatch<React.SetStateAction<Appointment | null>>;
  loading: boolean;
  /** Why the appointment could not be loaded (the server's message), if it could not. */
  loadError: string | null;
  editedAppointment: Partial<Appointment> | null;
  setEditedAppointment: React.Dispatch<
    React.SetStateAction<Partial<Appointment> | null>
  >;
  currentAddons: Appointment["addons"];
  setCurrentAddons: React.Dispatch<
    React.SetStateAction<Appointment["addons"]>
  >;
  activityLoading: boolean;
  refreshAppointment: () => Promise<void>;
  refreshActivity: () => Promise<void>;
}

type CatalogServices = ReadonlyArray<{
  id: string;
  name: string;
  price?: number | null;
  duration?: number | null;
}>;

export function useAppointmentData(
  appointmentId: string | null,
  refreshKey: number | undefined,
  services: CatalogServices,
  editMode: boolean,
  open: boolean,
): UseAppointmentDataResult {
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editedAppointment, setEditedAppointment] =
    useState<Partial<Appointment> | null>(null);
  const [currentAddons, setCurrentAddons] = useState<Appointment["addons"]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  // The newest request; an answer to any other is dropped.
  const latestRequest = useRef(0);
  // The id the drawer is on now, for answers that arrive after a switch.
  const currentId = useRef(appointmentId);
  currentId.current = appointmentId;
  const servicesRef = useRef(services);
  servicesRef.current = services;

  const fetchAppointment = async () => {
    const id = appointmentId;
    if (!id) return;
    const request = ++latestRequest.current;
    const stale = () => request !== latestRequest.current || currentId.current !== id;

    setLoading(true);
    try {
      const data = await apiClient.getAppointment(id);
      if (stale()) return;
      setAppointment(toDrawerAppointment(data, servicesRef.current));
      setLoadError(null);
    } catch (error) {
      if (stale()) return;
      console.error("Error fetching appointment:", error);
      setAppointment(null);
      setLoadError(serverMessage(error) ?? "");
    } finally {
      if (!stale()) setLoading(false);
    }
  };

  const fetchActivity = async () => {
    const id = appointmentId;
    if (!id) return;

    setActivityLoading(true);
    try {
      const activityData = (await apiClient.getAppointmentActivity(id)) as any[];

      // Not if the drawer moved to another appointment meanwhile.
      setAppointment((prev) =>
        prev && prev.id === id
          ? { ...prev, activity: mergeActivity(prev.createdAt, activityData) }
          : prev,
      );
    } catch (error) {
      console.error("Error fetching activity:", error);
    } finally {
      if (currentId.current === id) setActivityLoading(false);
    }
  };

  // The one fetch: on opening, on another appointment, and when the agenda
  // asks for a refresh. Another appointment's data is dropped at once, so it
  // never shows under this one's id while the request is out.
  useEffect(() => {
    if (!appointmentId || !open) {
      // A late answer to the previous appointment is not wanted either.
      latestRequest.current += 1;
      return;
    }
    setAppointment((prev) => (prev && prev.id === appointmentId ? prev : null));
    setLoadError(null);
    fetchAppointment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId, refreshKey, open]);

  // Ensure editedAppointment is initialized when editMode is enabled
  useEffect(() => {
    if (editMode && appointment && !editedAppointment) {
      setEditedAppointment({
        ...appointment,
        service: { ...appointment.service },
        professional: { ...appointment.professional },
        addons: [...appointment.addons],
      });
      setCurrentAddons([...appointment.addons]);
    }
  }, [editMode, appointment, editedAppointment]);

  // Add-ons are stored as ids: their names and prices come from the
  // catalog, which may arrive after the appointment.
  useEffect(() => {
    if (services.length === 0) return;
    setAppointment((prev) =>
      prev && prev.rawAddons && prev.addons.length === 0
        ? { ...prev, addons: transformAddons(prev.rawAddons, services) }
        : prev,
    );
  }, [services]);

  return {
    appointment,
    setAppointment,
    loading,
    loadError,
    editedAppointment,
    setEditedAppointment,
    currentAddons,
    setCurrentAddons,
    activityLoading,
    refreshAppointment: fetchAppointment,
    refreshActivity: fetchActivity,
  };
}
