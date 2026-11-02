import apiClient from "./api";

/**
 * Deactivating a location: what the confirmation says about the
 * appointments still to come there. They used to go unmentioned, so clients
 * who had booked at a closed location were not flagged to anyone.
 */
export function deactivationNotice(
  upcoming: number | null,
): { key: string; params?: Record<string, number> } | null {
  if (upcoming === null) return null; // the count could not be loaded: the dialog still asks
  if (upcoming === 0) return { key: "multiLocation.deactivate.noUpcoming" };
  if (upcoming === 1) return { key: "multiLocation.deactivate.upcomingOne" };
  return { key: "multiLocation.deactivate.upcomingMany", params: { count: upcoming } };
}

/** GET /locations/:id/deactivation-preview, or null when it fails. */
export async function upcomingAppointmentsAt(locationId: string): Promise<number | null> {
  try {
    const r = (await apiClient.request(`/locations/${locationId}/deactivation-preview`)) as {
      upcomingAppointments?: number;
    };
    return typeof r?.upcomingAppointments === "number" ? r.upcomingAppointments : null;
  } catch {
    return null;
  }
}
