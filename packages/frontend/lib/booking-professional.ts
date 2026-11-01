/**
 * A link or QR code for one professional (?professionalId=) keeps her chosen
 * on the salon's booking page: only the services she does are offered, and
 * picking one of them does not drop her. Pure, tested in
 * booking-professional.spec.ts.
 */

export interface ProfessionalWithServices {
  id: string;
  firstName?: string;
  services?: Array<{ serviceId?: string; service?: { id: string } }>;
}

function serviceIdsOf(pro: ProfessionalWithServices): string[] {
  return (pro.services ?? []).map((l) => l.service?.id ?? l.serviceId ?? "").filter(Boolean);
}

/** Whether she does the service. One with no services linked at all counts as doing every one. */
export function performsService(pro: ProfessionalWithServices | undefined, serviceId: string): boolean {
  if (!pro) return false;
  const ids = serviceIdsOf(pro);
  return ids.length === 0 || ids.includes(serviceId);
}

/**
 * The services to offer: with a professional pinned by the link, the ones
 * she does (all of them when she has none linked, rather than none).
 */
export function servicesForPinned<S extends { id: string }>(
  services: S[],
  pinned: ProfessionalWithServices | undefined,
): S[] {
  if (!pinned) return services;
  const ids = serviceIdsOf(pinned);
  if (ids.length === 0) return services;
  const mine = services.filter((s) => ids.includes(s.id));
  return mine.length > 0 ? mine : services;
}

/**
 * Who stays chosen when the service changes: the same professional if she
 * does the new service, else nobody (the client picks again).
 */
export function professionalAfterServiceChange(
  currentProfessionalId: string,
  serviceId: string,
  professionals: ProfessionalWithServices[],
): string {
  if (!currentProfessionalId) return "";
  if (!serviceId) return currentProfessionalId;
  const pro = professionals.find((p) => p.id === currentProfessionalId);
  return performsService(pro, serviceId) ? currentProfessionalId : "";
}
