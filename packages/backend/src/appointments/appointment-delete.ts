import { AppointmentStatus, PaymentStatus } from "@prisma/client";
import type { PrismaService } from "../common/prisma/prisma.service";

/**
 * Whether an appointment may be hard-deleted, and why not.
 *
 * A completed appointment, one with money on it or one that was invoiced is
 * the salon's history and accounting: deleting it would lose the record
 * (and, for an invoice, break the fiscal trail). Those are cancelled, not
 * deleted. A pending, confirmed, cancelled or no-show appointment with no
 * money attached can still go.
 *
 * Returns the Spanish message for the 409, or null when it may be deleted.
 */
export async function appointmentDeleteBlocker(
  prisma: PrismaService,
  appointment: {
    id: string;
    tenantId: string;
    status: AppointmentStatus | string;
    paymentStatus?: PaymentStatus | string | null;
    amountPaid?: unknown;
    depositPaid?: boolean | null;
  },
): Promise<string | null> {
  if (appointment.status === AppointmentStatus.completed) {
    return "No se puede eliminar una cita completada: forma parte del historial del salón.";
  }

  // Money can be on the appointment itself (marked paid from the agenda)
  // as well as in a Payment row (card, deposit, refund).
  const paidOnAppointment =
    appointment.paymentStatus === PaymentStatus.paid ||
    appointment.paymentStatus === PaymentStatus.refunded ||
    appointment.depositPaid === true ||
    Number(appointment.amountPaid ?? 0) > 0;
  const payments = paidOnAppointment
    ? 1
    : await prisma.payment.count({ where: { tenantId: appointment.tenantId, appointmentId: appointment.id } });
  if (payments > 0) {
    return "No se puede eliminar una cita con pagos registrados: forma parte de la contabilidad. Cancélala en su lugar.";
  }

  const invoices = await prisma.invoice.count({
    where: {
      tenantId: appointment.tenantId,
      OR: [
        { sourceType: "appointment", sourceId: appointment.id },
        { lines: { some: { appointmentId: appointment.id } } },
      ],
    },
  });
  if (invoices > 0) {
    return "No se puede eliminar una cita facturada: la factura debe conservarse. Cancélala en su lugar.";
  }

  return null;
}

/**
 * Deletes an appointment that `appointmentDeleteBlocker` let through.
 *
 * Its activity log and work blocks (AppointmentService) cascade with it.
 * Rows that point at it without a foreign key -- a consent, a review, a
 * promotion use, a loyalty redemption, a stock movement, a rebooking
 * reminder, the rest of a recurring series -- stay, but stop pointing at an
 * appointment that no longer exists.
 */
export async function deleteAppointmentRow(prisma: PrismaService, id: string): Promise<void> {
  const unlink = { where: { appointmentId: id }, data: { appointmentId: null } };
  await prisma.$transaction([
    prisma.consent.updateMany(unlink),
    prisma.review.updateMany(unlink),
    prisma.promotionUsage.updateMany(unlink),
    prisma.loyaltyRedemption.updateMany(unlink),
    prisma.inventoryTransaction.updateMany(unlink),
    prisma.rebookingReminder.updateMany({
      where: { resultAppointmentId: id },
      data: { resultAppointmentId: null },
    }),
    prisma.appointment.updateMany({
      where: { parentAppointmentId: id },
      data: { parentAppointmentId: null },
    }),
    prisma.appointment.delete({ where: { id } }),
  ]);
}
