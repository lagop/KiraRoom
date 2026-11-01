/**
 * A link or QR code for one professional (?professionalId=) keeps her chosen
 * on the salon's booking page: only the services she does are offered, and
 * picking one of them does not drop her. "Does" is the booking page's own
 * rule (professionalsForService): the professionals linked to the service,
 * or everyone when nobody is. Pure, tested in booking-professional.spec.ts.
 */
import { LocatedProfessional, professionalsForService } from "./public-booking-locations";

/** Whether she can be booked for the service, by the same rule as the professional list. */
export function performsService<T extends LocatedProfessional>(
  pro: T | undefined,
  serviceId: string,
  professionals: T[],
): boolean {
  if (!pro || !serviceId) return false;
  return professionalsForService(professionals, serviceId).some((p) => p.id === pro.id);
}

/**
 * The services to offer: with a professional pinned by the link, the ones
 * she does (every one when none of them is hers, rather than none).
 */
export function servicesForPinned<S extends { id: string }, T extends LocatedProfessional>(
  services: S[],
  pinned: T | undefined,
  professionals: T[],
): S[] {
  if (!pinned) return services;
  const mine = services.filter((s) => performsService(pinned, s.id, professionals));
  return mine.length > 0 ? mine : services;
}

/**
 * Who stays chosen when the service changes: the same professional if she
 * does the new service, else nobody (the client picks again).
 */
export function professionalAfterServiceChange<T extends LocatedProfessional>(
  currentProfessionalId: string,
  serviceId: string,
  professionals: T[],
): string {
  if (!currentProfessionalId) return "";
  if (!serviceId) return currentProfessionalId;
  const pro = professionals.find((p) => p.id === currentProfessionalId);
  return performsService(pro, serviceId, professionals) ? currentProfessionalId : "";
}
