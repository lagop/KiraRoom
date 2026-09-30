import type { SalonToolContext } from './salon-tools';

/**
 * Turns what the model passes as serviceId / professionalId into a real id.
 *
 * The conversation history the model sees keeps only the text of earlier
 * turns, not the tool results, so a UUID from list_services two messages ago
 * is gone. The model then sent the service's name, or an id it made up, and
 * check_availability / propose_appointment failed on their first call every
 * time ("Service not found", invalid_input serviceId). A name is as good as
 * an id when it names exactly one of the salon's own services or
 * professionals.
 */

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The one candidate `value` names: its id, its exact name, or the only name containing it. */
function pick<T extends { id: string; names: string[] }>(value: string, candidates: T[]): T | undefined {
  const byId = candidates.find((c) => c.id.toLowerCase() === value.toLowerCase());
  if (byId) return byId;
  const wanted = normalize(value);
  if (!wanted) return undefined;
  const exact = candidates.filter((c) => c.names.some((n) => normalize(n) === wanted));
  if (exact.length === 1) return exact[0];
  const partial = candidates.filter((c) => c.names.some((n) => normalize(n).includes(wanted)));
  return partial.length === 1 ? partial[0] : undefined;
}

export type Resolved =
  | { ok: true; args: Record<string, unknown>; error?: undefined }
  | { ok: false; error: Record<string, unknown>; args?: undefined };

/**
 * Resolves `serviceId` and, when given, `professionalId` in `args`. When one
 * cannot be resolved, the error lists the valid options so the model can
 * retry in the same turn instead of asking the client again.
 */
export async function resolveIds(
  ctx: SalonToolContext,
  args: Record<string, unknown>,
): Promise<Resolved> {
  const out = { ...args };

  if (typeof args.serviceId === 'string' && args.serviceId.trim()) {
    const services = await ctx.prisma.service.findMany({
      where: { tenantId: ctx.tenantId, isActive: true },
      select: { id: true, name: true },
    });
    const match = pick(
      args.serviceId.trim(),
      services.map((s) => ({ id: s.id, names: [s.name] })),
    );
    if (!match) {
      return {
        ok: false,
        error: {
          error: 'service_not_found',
          message: 'Use one of these service ids and call the tool again.',
          services: services.map((s) => ({ id: s.id, name: s.name })),
        },
      };
    }
    out.serviceId = match.id;
  }

  if (typeof args.professionalId === 'string' && args.professionalId.trim()) {
    const professionals = await ctx.prisma.professional.findMany({
      where: { tenantId: ctx.tenantId, isActive: true },
      select: { id: true, firstName: true, lastName: true, services: { select: { serviceId: true } } },
    });
    const match = pick(
      args.professionalId.trim(),
      professionals.map((p) => ({
        id: p.id,
        names: [`${p.firstName} ${p.lastName}`, p.firstName],
      })),
    );
    if (!match) {
      return {
        ok: false,
        error: {
          error: 'professional_not_found',
          message: 'Use one of these professional ids, or omit it for whoever is free, and call the tool again.',
          professionals: professionals.map((p) => ({
            id: p.id,
            name: `${p.firstName} ${p.lastName}`.trim(),
          })),
        },
      };
    }
    out.professionalId = match.id;

    // A named professional must offer the service. Nothing checked it: a
    // massage "with Carmen", a hairdresser, got Carmen's free hours, and the
    // booking would have gone to her. As in findFreeProfessional, a service
    // nobody is linked to is open to everyone.
    const serviceId = out.serviceId as string | undefined;
    if (serviceId) {
      const offers = (p: { services?: Array<{ serviceId: string }> }) =>
        (p.services ?? []).some((s) => s.serviceId === serviceId);
      const offering = professionals.filter(offers);
      const chosen = professionals.find((p) => p.id === match.id)!;
      if (offering.length > 0 && !offers(chosen)) {
        return {
          ok: false,
          error: {
            error: 'professional_does_not_offer_service',
            message:
              'This professional does not do this service. Tell the client, and offer these instead or whoever is free.',
            professionals: offering.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`.trim() })),
          },
        };
      }
    }
  }

  return { ok: true, args: out };
}
