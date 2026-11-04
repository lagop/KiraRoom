import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma/prisma.service";
import { salonToday } from "../analytics/analytics-metrics";
import { safeTimeZone } from "../gift-cards/gift-card-expiry";
import { deleteAppointmentRow } from "../appointments/appointment-delete";
import { clientHasHistory, isForeignKeyViolation } from "../common/prisma/history-deletes";
import { MonitoredJob } from "../common/ops-alerts/ops-alert-sink";

/** Rows looked at per run: the wizard makes at most one per salon. */
const BATCH = 200;

export interface TestBookingCleanupResult {
  deletedAppointments: number;
  deletedClients: number;
  /** With money, a till line or an invoice: kept, and counted from now on. */
  keptAsReal: number;
}

/**
 * D27: the onboarding wizard's test booking is deleted the salon day after
 * it was made, with its test client when she has nothing else (no other
 * appointment, payment, purchase or balance). D11: a completed one goes too.
 *
 * It runs every hour so "the next day" is the salon's, whatever its time
 * zone. A test booking with money on it (a payment, a deposit, a paid
 * commission), a till (POS) line or an invoice is not deleted: that is
 * accounting. It stops being a test and counts like any other. Completing
 * it in the agenda alone (trying the flow out) no longer keeps it. A test client
 * who has other history is kept the same way.
 */
@Injectable()
export class TestBookingCleanupService {
  private readonly logger = new Logger(TestBookingCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron("17 * * * *")
  @MonitoredJob("TestBookingCleanupService.runScheduled")
  async runScheduled(): Promise<void> {
    try {
      const r = await this.cleanup();
      if (r.deletedAppointments || r.deletedClients || r.keptAsReal) {
        this.logger.log(
          `test bookings: ${r.deletedAppointments} deleted, ${r.deletedClients} test clients deleted, ${r.keptAsReal} kept as real`,
        );
      }
    } catch (err) {
      this.logger.error(`test booking cleanup failed: ${(err as Error).message}`);
    }
  }

  async cleanup(now: Date = new Date()): Promise<TestBookingCleanupResult> {
    const result: TestBookingCleanupResult = { deletedAppointments: 0, deletedClients: 0, keptAsReal: 0 };
    const rows = await this.prisma.appointment.findMany({
      where: { isTest: true },
      orderBy: { createdAt: "asc" },
      take: BATCH,
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        status: true,
        paymentStatus: true,
        amountPaid: true,
        depositPaid: true,
        commissionPaid: true,
        createdAt: true,
        tenant: { select: { timezone: true } },
      },
    });

    for (const row of rows) {
      const tz = safeTimeZone(row.tenant?.timezone);
      // Made today (the salon's day): it stays until tomorrow.
      if (salonToday(tz, row.createdAt) >= salonToday(tz, now)) continue;
      try {
        const keep = await this.keepReason(row);
        if (keep) {
          await this.prisma.appointment.updateMany({
            where: { id: row.id, tenantId: row.tenantId },
            data: { isTest: false },
          });
          result.keptAsReal++;
        } else {
          await deleteAppointmentRow(this.prisma, row.id);
          result.deletedAppointments++;
        }
        if (row.clientId && (await this.removeTestClient(row.tenantId, row.clientId))) {
          result.deletedClients++;
        }
      } catch (err) {
        this.logger.warn(`test booking ${row.id} not cleaned up: ${(err as Error).message}`);
      }
    }
    return result;
  }

  /**
   * Why a test booking must stay (accounting), or null when it can go,
   * whatever its status: money on the appointment or in a Payment, a paid
   * or adjusted commission, a till sale line, or an invoice.
   */
  private async keepReason(row: {
    id: string;
    tenantId: string;
    paymentStatus?: string | null;
    amountPaid?: unknown;
    depositPaid?: boolean | null;
    commissionPaid?: boolean | null;
  }): Promise<string | null> {
    if (
      row.paymentStatus === "paid" ||
      row.paymentStatus === "refunded" ||
      row.depositPaid === true ||
      Number(row.amountPaid ?? 0) > 0
    ) {
      return "paid";
    }
    if (row.commissionPaid === true) return "commission";
    const where = { tenantId: row.tenantId, appointmentId: row.id };
    if ((await this.prisma.payment.count({ where })) > 0) return "payment";
    if ((await this.prisma.posSaleLine.count({ where })) > 0) return "pos";
    if ((await this.prisma.commissionAdjustment.count({ where })) > 0) return "commission";
    const invoices = await this.prisma.invoice.count({
      where: {
        tenantId: row.tenantId,
        OR: [{ sourceType: "appointment", sourceId: row.id }, { lines: { some: { appointmentId: row.id } } }],
      },
    });
    return invoices > 0 ? "invoice" : null;
  }

  /** Deletes the wizard's test client when she has nothing left; true if deleted. */
  private async removeTestClient(tenantId: string, clientId: string): Promise<boolean> {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId, isTest: true },
      select: { id: true },
    });
    if (!client) return false; // a real client the wizard reused: never touched
    // Another test booking of hers (the wizard run again): she goes with it.
    const testLeft = await this.prisma.appointment.count({ where: { tenantId, clientId, isTest: true } });
    if (testLeft > 0) return false;
    if (await clientHasHistory(this.prisma, tenantId, clientId)) {
      // The salon has used her since: she is a real client now.
      await this.prisma.client.updateMany({ where: { id: clientId, tenantId }, data: { isTest: false } });
      return false;
    }
    try {
      await this.prisma.client.delete({ where: { id: clientId, tenantId } });
      return true;
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        await this.prisma.client.updateMany({ where: { id: clientId, tenantId }, data: { isTest: false } });
        return false;
      }
      throw err;
    }
  }
}
