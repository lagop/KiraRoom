import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma/prisma.service";
import { salonToday } from "../analytics/analytics-metrics";
import { safeTimeZone } from "../gift-cards/gift-card-expiry";
import { appointmentDeleteBlocker, deleteAppointmentRow } from "../appointments/appointment-delete";
import { clientHasHistory, isForeignKeyViolation } from "../common/prisma/history-deletes";

/** Rows looked at per run: the wizard makes at most one per salon. */
const BATCH = 200;

export interface TestBookingCleanupResult {
  deletedAppointments: number;
  deletedClients: number;
  /** Charged, invoiced or completed: kept, and counted from now on. */
  keptAsReal: number;
}

/**
 * D27: the onboarding wizard's test booking is deleted the salon day after
 * it was made, with its test client when she has nothing else (no other
 * appointment, payment, purchase or balance).
 *
 * It runs every hour so "the next day" is the salon's, whatever its time
 * zone. A test booking the salon went on to charge, invoice or complete
 * is not deleted (appointmentDeleteBlocker: that is accounting and
 * history): it stops being a test and counts like any other. A test client
 * who has other history is kept the same way.
 */
@Injectable()
export class TestBookingCleanupService {
  private readonly logger = new Logger(TestBookingCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron("17 * * * *")
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
        createdAt: true,
        tenant: { select: { timezone: true } },
      },
    });

    for (const row of rows) {
      const tz = safeTimeZone(row.tenant?.timezone);
      // Made today (the salon's day): it stays until tomorrow.
      if (salonToday(tz, row.createdAt) >= salonToday(tz, now)) continue;
      try {
        const blocker = await appointmentDeleteBlocker(this.prisma, row);
        if (blocker) {
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
