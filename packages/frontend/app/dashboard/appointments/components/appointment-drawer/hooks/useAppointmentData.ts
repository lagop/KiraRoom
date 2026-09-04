import { useEffect, useState } from "react";
import apiClient from "../../../../../../lib/api";
import { transformAddons } from "../../appointment-drawer.utils";
import type { Appointment } from "../types";

/**
 * Loads + caches the appointment being viewed/edited and its activity
 * feed. Owns:
 *   - `appointment`, `loading`, `editedAppointment`, `currentAddons`,
 *     `activityLoading` state
 *   - `fetchAppointment` (was appointment-drawer.tsx:863-945)
 *   - `fetchActivity`     (was appointment-drawer.tsx:950-1029)
 *   - the `useEffect` that re-fetches when `appointmentId` /
 *     `refreshKey` changes (was appointment-drawer.tsx:692-741)
 *   - the `useEffect` that initialises `editedAppointment` when
 *     entering edit mode (was appointment-drawer.tsx:780-795)
 *   - the `useEffect` that transforms raw addons once services load
 *     (was appointment-drawer.tsx:797-813)
 *
 * The hook exposes setters for everything the drawer still mutates
 * (e.g. the `setAppointment` call inside `handleStatusChange`).
 */

export interface UseAppointmentDataResult {
  appointment: Appointment | null;
  setAppointment: React.Dispatch<React.SetStateAction<Appointment | null>>;
  loading: boolean;
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

export function useAppointmentData(
  appointmentId: string | null,
  refreshKey: number | undefined,
  services: ReadonlyArray<{ id: string; name: string; price?: number | null; duration?: number | null }>,
  editMode: boolean,
  open: boolean,
): UseAppointmentDataResult {
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [loading, setLoading] = useState(false);
  const [editedAppointment, setEditedAppointment] =
    useState<Partial<Appointment> | null>(null);
  const [currentAddons, setCurrentAddons] = useState<Appointment["addons"]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  const fetchAppointment = async () => {
    if (!appointmentId) return;

    try {
      setLoading(true);
      const data = (await apiClient.getAppointment(appointmentId)) as any;

      // Transform API response to match our interface (verbatim from line 872-937)
      const transformedAppointment: Appointment = {
        id: data.id,
        client: {
          id: data.client.id,
          name: `${data.client.firstName} ${data.client.lastName}`,
          email: data.client.email || "",
          phone: data.client.phone || "",
        },
        professional: {
          id: data.professional.id,
          name: `${data.professional.firstName} ${data.professional.lastName}`,
          email: data.professional.email,
          phone: data.professional.phone || "",
          specialty: data.professional.specialties?.[0] || "General",
        },
        service: {
          id: data.service.id,
          name: data.service.name,
          description: data.service.description || "",
          duration: data.service.duration,
          price: data.service.price,
        },
        services:
          data.services?.map((s: any) => ({
            id: s.id,
            service: {
              id: s.service.id,
              name: s.service.name,
              description: s.service.description || "",
              duration: s.service.duration,
              price: s.service.price,
            },
            professional: s.professional
              ? {
                  id: s.professional.id,
                  firstName: s.professional.firstName,
                  lastName: s.professional.lastName,
                  email: s.professional.email,
                  phone: s.professional.phone || "",
                  specialties: s.professional.specialties || [],
                }
              : undefined,
            isParallel: s.isParallel,
            scheduledStart: s.scheduledStart,
            scheduledEnd: s.scheduledEnd,
          })) || [],
        addons: [], // Will be transformed after services are loaded
        rawAddons: data.addons,
        date: data.scheduledDate.split("T")[0],
        time: data.scheduledTime,
        status: data.status as Appointment["status"],
        price: data.price,
        notes: data.notes || "",
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        activity: [
          ...(data.activity || []),
          {
            timestamp: data.createdAt,
            action: "Appointment created",
            details: undefined,
          },
        ],
      };

      setAppointment(transformedAppointment);
    } catch (error) {
      console.error("Error fetching appointment:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchActivity = async () => {
    if (!appointmentId) return;

    setActivityLoading(true);

    try {
      const activityData = (await apiClient.getAppointmentActivity(
        appointmentId,
      )) as any;

      setAppointment((prev) => {
        if (!prev) return null;

        const creationActivity = {
          timestamp: prev.createdAt,
          action: "Appointment created",
          details: undefined,
        };

        const backendActivity =
          activityData && activityData.length > 0
            ? activityData.map((activity: any) => ({
                timestamp: activity.createdAt,
                action: activity.action,
                details: activity.details
                  ? JSON.stringify(activity.details)
                  : undefined,
              }))
            : [];

        const activityMap = new Map();
        activityMap.set(
          `${creationActivity.timestamp}-${creationActivity.action}`,
          creationActivity,
        );
        backendActivity.forEach((activity: any) => {
          const key = `${activity.timestamp}-${activity.action}`;
          if (!activityMap.has(key)) {
            activityMap.set(key, activity);
          }
        });

        const allActivity = Array.from(activityMap.values()).sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        );

        return { ...prev, activity: allActivity };
      });
    } catch (error) {
      console.error("Error fetching activity:", error);
      setAppointment((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          activity: [
            {
              timestamp: prev.createdAt,
              action: "Appointment created",
              details: undefined,
            },
          ],
        };
      });
    } finally {
      setActivityLoading(false);
    }
  };

  // Re-fetch when appointmentId / refreshKey / open changes (verbatim from
  // appointment-drawer.tsx:692-755 minus the showClientSuggestions reset
  // which is now owned by ClientPickerSection).
  useEffect(() => {
    if (!appointmentId || !open) {
      return;
    }
    fetchAppointment();
    // The original effect also reset newAppointment, etc. for the
    // create-mode branch. Those reset paths stay in the orchestrator
    // because they touch create-mode form state, not appointment
    // data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentId, refreshKey, open]);

  // Ensure editedAppointment is initialized when editMode is enabled
  // (verbatim from appointment-drawer.tsx:780-795)
  useEffect(() => {
    if (editMode && appointment && !editedAppointment) {
      const editedApp = {
        ...appointment,
        date: appointment.date,
        time: appointment.time,
        notes: appointment.notes,
        service: { ...appointment.service },
        professional: { ...appointment.professional },
        addons: [...appointment.addons],
      };
      setEditedAppointment(editedApp);
      setCurrentAddons([...appointment.addons]);
    }
  }, [editMode, appointment, editedAppointment]);

  // Transform add-ons when services are loaded and appointment has
  // rawAddons (verbatim from appointment-drawer.tsx:797-813)
  useEffect(() => {
    if (
      appointment &&
      appointment.rawAddons &&
      services.length > 0 &&
      appointment.addons.length === 0
    ) {
      const transformedAddons = transformAddons(
        appointment.rawAddons,
        services as any,
      );
      setAppointment((prev) =>
        prev ? { ...prev, addons: transformedAddons } : null,
      );
    }
  }, [services]);

  return {
    appointment,
    setAppointment,
    loading,
    editedAppointment,
    setEditedAppointment,
    currentAddons,
    setCurrentAddons,
    activityLoading,
    refreshAppointment: fetchAppointment,
    refreshActivity: fetchActivity,
  };
}