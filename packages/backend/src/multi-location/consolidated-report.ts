/**
 * The consolidated multi-location report, as a pure function of the rows the
 * service loads.
 *
 * The report used to sum payments "where appointment.locationId = X" while
 * no booking wrote that column, and showed every location at 0 €. Bookings
 * now store it (see appointment-location.ts) and a migration filled it in
 * for professionals with a single location, but older rows of professionals
 * with several still have none. An appointment's location is therefore
 * taken from the appointment when it has one, and otherwise from where its
 * professional works: their only active location, or their primary one when
 * they are assigned to several. Appointments that still have no location (a
 * professional assigned nowhere, or to several with none primary) are
 * reported apart as "sin local asignado" instead of being dropped, so the
 * per-location rows always add up to the salon's total.
 *
 * Revenue, appointments and occupancy use the same definitions as the
 * analytics screen (see analytics-metrics.ts).
 */

import {
  AnalyticsAppointment,
  Occupancy,
  SalonPeriod,
  occupancy,
  summarize,
  topServices,
} from "../analytics/analytics-metrics";

export interface LocationLink {
  professionalId: string;
  locationId: string;
  isPrimary: boolean;
}

/** Each professional's home location among the active ones, when it is unambiguous. */
export function homeLocations(
  links: ReadonlyArray<LocationLink>,
  activeLocationIds: ReadonlySet<string>,
): Map<string, string> {
  const byProfessional = new Map<string, LocationLink[]>();
  for (const l of links) {
    if (!activeLocationIds.has(l.locationId)) continue;
    const list = byProfessional.get(l.professionalId) ?? [];
    list.push(l);
    byProfessional.set(l.professionalId, list);
  }
  const homes = new Map<string, string>();
  for (const [professionalId, list] of byProfessional) {
    if (list.length === 1) {
      homes.set(professionalId, list[0].locationId);
      continue;
    }
    const primaries = list.filter((l) => l.isPrimary);
    if (primaries.length === 1) homes.set(professionalId, primaries[0].locationId);
  }
  return homes;
}

export function locationOf(
  appointment: { locationId?: string | null; professionalId?: string | null },
  homes: ReadonlyMap<string, string>,
): string | null {
  if (appointment.locationId) return appointment.locationId;
  if (appointment.professionalId) return homes.get(appointment.professionalId) ?? null;
  return null;
}

export interface LocationReportRow {
  locationId: string;
  name: string;
  revenue: number;
  appointments: number;
  completedAppointments: number;
  paidAppointments: number;
  avgTicket: number;
  occupancy: Occupancy;
  professionals: number;
  /** Distinct clients with an appointment (not cancelled) at this location. */
  clients: number;
  topServices: { name: string; count: number; revenue: number }[];
}

export interface ConsolidatedReport {
  period: SalonPeriod;
  activeLocations: number;
  totals: {
    revenue: number;
    appointments: number;
    completedAppointments: number;
    paidAppointments: number;
    avgTicket: number;
    occupancy: Occupancy;
  };
  perLocation: LocationReportRow[];
  /** Appointments that could not be attributed to an active location. */
  unassigned: { revenue: number; appointments: number };
  /** Money is in cents. */
  currencyUnit: "cents";
}

export function buildConsolidatedReport(input: {
  period: SalonPeriod;
  locations: ReadonlyArray<{ id: string; name: string }>;
  appointments: ReadonlyArray<AnalyticsAppointment>;
  professionals: ReadonlyArray<{ id: string; workingHours?: unknown }>;
  links: ReadonlyArray<LocationLink>;
}): ConsolidatedReport {
  const { period, locations, appointments, professionals, links } = input;
  const activeIds = new Set(locations.map((l) => l.id));
  const homes = homeLocations(links, activeIds);

  const byLocation = new Map<string, AnalyticsAppointment[]>(
    locations.map((l) => [l.id, []]),
  );
  const unassigned: AnalyticsAppointment[] = [];
  for (const a of appointments) {
    const loc = locationOf(a, homes);
    const bucket = loc ? byLocation.get(loc) : undefined;
    (bucket ?? unassigned).push(a);
  }

  const perLocation = locations.map((loc): LocationReportRow => {
    const rows = byLocation.get(loc.id) ?? [];
    const staff = professionals.filter((p) => homes.get(p.id) === loc.id);
    const summary = summarize(rows);
    return {
      locationId: loc.id,
      name: loc.name,
      ...summary,
      occupancy: occupancy(staff, rows, period),
      professionals: staff.length,
      clients: new Set(rows.filter((a) => a.status !== "cancelled" && a.clientId).map((a) => a.clientId)).size,
      topServices: topServices(rows, 3),
    };
  });

  const total = summarize(appointments);
  const rest = summarize(unassigned);
  return {
    period,
    activeLocations: locations.length,
    totals: {
      revenue: total.revenue,
      appointments: total.appointments,
      completedAppointments: total.completedAppointments,
      paidAppointments: total.paidAppointments,
      avgTicket: total.avgTicket,
      occupancy: occupancy(professionals, appointments, period),
    },
    perLocation,
    unassigned: { revenue: rest.revenue, appointments: rest.appointments },
    currencyUnit: "cents",
  };
}
