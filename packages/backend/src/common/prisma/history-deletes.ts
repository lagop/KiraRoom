import { ConflictException, NotFoundException } from "@nestjs/common";
import { ClientStatus } from "@prisma/client";
import type { PrismaService } from "./prisma.service";

/**
 * Deleting a client, professional or service from the panel.
 *
 * Their appointments and payments are the salon's history and its
 * accounting. Deleting the record used to cascade to all its appointments
 * (and leave their payments pointing nowhere); the database now refuses
 * (onDelete: Restrict, migration 20261031010000_restrict_history_deletes).
 *
 * So a record WITH history is deactivated instead: it stops showing up for
 * booking but stays on every past appointment, payment and report. One
 * without history is still deleted. If history appears between the check
 * and the delete, the database refuses and the salon gets a 409 that says
 * why, not a 500.
 */
export interface HistoryDeleteResult {
  ok: true;
  /** true: it had history, so it was deactivated rather than deleted. */
  deactivated: boolean;
}

export const CLIENT_HAS_HISTORY =
  "Esta clienta tiene citas, pagos, compras o saldo en su historial y no se puede eliminar. Desactívala para ocultarla sin perder ese historial.";
export const PROFESSIONAL_HAS_HISTORY =
  "Este profesional tiene citas en su historial y no se puede eliminar. Desactívalo para que deje de aparecer en las reservas.";
export const SERVICE_HAS_HISTORY =
  "Este servicio tiene citas en su historial y no se puede eliminar. Desactívalo para que deje de poder reservarse.";

/** Prisma's "a foreign key still points at this row". */
export function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2003";
}

async function deleteOrDeactivate(
  hasHistory: () => Promise<boolean>,
  deactivate: () => Promise<unknown>,
  remove: () => Promise<unknown>,
  conflictMessage: string,
): Promise<HistoryDeleteResult> {
  if (await hasHistory()) {
    await deactivate();
    return { ok: true, deactivated: true };
  }
  try {
    await remove();
  } catch (error) {
    if (isForeignKeyViolation(error)) throw new ConflictException(conflictMessage);
    throw error;
  }
  return { ok: true, deactivated: false };
}

const anyOf = async (...counts: Promise<number>[]) =>
  (await Promise.all(counts)).some((n) => n > 0);

export async function deleteClientKeepingHistory(
  prisma: PrismaService,
  tenantId: string,
  id: string,
): Promise<HistoryDeleteResult> {
  const client = await prisma.client.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!client) throw new NotFoundException("Cliente no encontrado");
  return deleteOrDeactivate(
    () =>
      anyOf(
        prisma.appointment.count({ where: { tenantId, clientId: id } }),
        prisma.payment.count({ where: { tenantId, clientId: id } }),
        prisma.order.count({ where: { tenantId, clientId: id } }),
        // A balance or points she has not used yet is owed to her.
        prisma.clientWallet.count({
          where: { tenantId, clientId: id, OR: [{ balance: { not: 0 } }, { loyaltyPoints: { not: 0 } }] },
        }),
        prisma.loyaltyMember.count({ where: { clientId: id, currentPoints: { not: 0 } } }),
      ),
    () => prisma.client.update({ where: { id, tenantId }, data: { status: ClientStatus.inactive } }),
    () => prisma.client.delete({ where: { id, tenantId } }),
    CLIENT_HAS_HISTORY,
  );
}

export async function deleteProfessionalKeepingHistory(
  prisma: PrismaService,
  tenantId: string,
  id: string,
): Promise<HistoryDeleteResult> {
  const professional = await prisma.professional.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!professional) throw new NotFoundException("Profesional no encontrado");
  return deleteOrDeactivate(
    () =>
      anyOf(
        prisma.appointment.count({ where: { tenantId, professionalId: id } }),
        // A block of someone else's appointment (e.g. the rinse after a colour).
        prisma.appointmentService.count({ where: { professionalId: id } }),
      ),
    () => prisma.professional.update({ where: { id, tenantId }, data: { isActive: false } }),
    () => prisma.professional.delete({ where: { id, tenantId } }),
    PROFESSIONAL_HAS_HISTORY,
  );
}

export async function deleteServiceKeepingHistory(
  prisma: PrismaService,
  tenantId: string,
  id: string,
): Promise<HistoryDeleteResult> {
  const service = await prisma.service.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!service) throw new NotFoundException("Servicio no encontrado");
  return deleteOrDeactivate(
    () =>
      anyOf(
        prisma.appointment.count({ where: { tenantId, serviceId: id } }),
        // A second service inside a multi-service appointment.
        prisma.appointmentService.count({ where: { serviceId: id } }),
      ),
    () => prisma.service.update({ where: { id, tenantId }, data: { isActive: false } }),
    () => prisma.service.delete({ where: { id, tenantId } }),
    SERVICE_HAS_HISTORY,
  );
}
