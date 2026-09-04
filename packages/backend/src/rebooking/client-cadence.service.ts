import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { RebookChannel, RebookStatus } from "@prisma/client";

export interface CadenceByService {
  avgDays: number;
  stdDevDays: number;
  lastVisit: string;
  visitsCount: number;
  nextExpectedAt: string;
}

export interface ReminderSentForEntry {
  serviceId: string;
  sentAt: string;
  channel: RebookChannel;
}

const DEFAULT_LEAD_DAYS = 3;
const DEFAULT_MIN_VISITS = 3;
const STD_DEV_CAP_DAYS = 30;
const LOOKBACK_APPOINTMENTS = 10;

function clampStdDev(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(value, STD_DEV_CAP_DAYS);
}

@Injectable()
export class ClientCadenceService {
  private readonly logger = new Logger(ClientCadenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the per-tenant rebooking settings, with sane defaults.
   */
  async getTenantConfig(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { rebookingSettings: true },
    });
    const raw = (t?.rebookingSettings as Record<string, unknown> | null) ?? {};
    return {
      enabled: raw.enabled !== false,
      leadDays: typeof raw.leadDays === "number" ? (raw.leadDays as number) : DEFAULT_LEAD_DAYS,
      channelFallback:
        raw.channelFallback === "email" || raw.channelFallback === "whatsapp"
          ? (raw.channelFallback as "email" | "whatsapp")
          : ("both" as const),
      minVisits:
        typeof raw.minVisits === "number"
          ? (raw.minVisits as number)
          : DEFAULT_MIN_VISITS,
    };
  }

  /**
   * Recompute the cadence for a single client based on the last
   * `LOOKBACK_APPOINTMENTS` completed appointments, grouped by service.
   */
  async computeForClient(clientId: string): Promise<void> {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, tenantId: true },
    });
    if (!client) return;

    const tenantConfig = await this.getTenantConfig(client.tenantId);
    if (!tenantConfig.enabled) {
      // Persist an empty cadence so future ticks know we visited this client.
      await this.prisma.clientCadence.upsert({
        where: { clientId },
        create: {
          clientId,
          tenantId: client.tenantId,
          byService: {},
          lastComputedAt: new Date(),
        },
        update: {
          byService: {},
          lastComputedAt: new Date(),
        },
      });
      return;
    }

    const appointments = await this.prisma.appointment.findMany({
      where: {
        clientId,
        status: "completed",
        completionTime: { not: null },
      },
      orderBy: { completionTime: "desc" },
      take: LOOKBACK_APPOINTMENTS * 3, // safety upper bound
      select: {
        serviceId: true,
        completionTime: true,
        scheduledDate: true,
      },
    });

    // Group by service.
    const byServiceMap = new Map<string, Date[]>();
    for (const a of appointments) {
      const when = a.completionTime ?? a.scheduledDate;
      if (!when) continue;
      const list = byServiceMap.get(a.serviceId) ?? [];
      list.push(when);
      byServiceMap.set(a.serviceId, list);
    }

    const byService: Record<string, CadenceByService> = {};
    let nextRecommendedReminderAt: Date | null = null;
    let recommendedServiceId: string | null = null;

    for (const [serviceId, dates] of byServiceMap.entries()) {
      if (dates.length < tenantConfig.minVisits) continue;
      // Sort ascending so we can compute diffs.
      dates.sort((a, b) => a.getTime() - b.getTime());
      const lastVisit = dates[dates.length - 1];
      const diffs: number[] = [];
      for (let i = 1; i < dates.length; i++) {
        const d =
          (dates[i].getTime() - dates[i - 1].getTime()) / (1000 * 60 * 60 * 24);
        diffs.push(d);
      }
      const avg = diffs.reduce((s, x) => s + x, 0) / diffs.length;
      const variance =
        diffs.reduce((s, x) => s + Math.pow(x - avg, 2), 0) / diffs.length;
      const stdDev = clampStdDev(Math.sqrt(variance));

      const nextExpectedAt = new Date(
        lastVisit.getTime() + avg * 24 * 60 * 60 * 1000,
      );
      const candidate = new Date(
        nextExpectedAt.getTime() -
          tenantConfig.leadDays * 24 * 60 * 60 * 1000,
      );

      byService[serviceId] = {
        avgDays: Math.round(avg * 10) / 10,
        stdDevDays: Math.round(stdDev * 10) / 10,
        lastVisit: lastVisit.toISOString(),
        visitsCount: dates.length,
        nextExpectedAt: nextExpectedAt.toISOString(),
      };

      if (
        !nextRecommendedReminderAt ||
        candidate.getTime() < nextRecommendedReminderAt.getTime()
      ) {
        nextRecommendedReminderAt = candidate;
        recommendedServiceId = serviceId;
      }
    }

    // Preserve any existing reminderSentFor entries; we don't auto-clear them.
    const existing = await this.prisma.clientCadence.findUnique({
      where: { clientId },
      select: { reminderSentFor: true },
    });
    const reminderSentFor =
      (existing?.reminderSentFor as unknown as ReminderSentForEntry[]) ?? [];

    await this.prisma.clientCadence.upsert({
      where: { clientId },
      create: {
        clientId,
        tenantId: client.tenantId,
        byService: byService as any,
        nextRecommendedReminderAt,
        recommendedServiceId,
        reminderSentFor: reminderSentFor as any,
        lastComputedAt: new Date(),
      },
      update: {
        byService: byService as any,
        nextRecommendedReminderAt,
        recommendedServiceId,
        lastComputedAt: new Date(),
      },
    });
  }

  /**
   * Walk every client with >= minVisits completed appointments for a tenant
   * and refresh their cadence. Heavy operation — should be invoked from a
   * background job or one-off backfill script.
   */
  async computeForTenant(tenantId: string): Promise<number> {
    const cfg = await this.getTenantConfig(tenantId);
    const completed = await this.prisma.appointment.findMany({
      where: { tenantId, status: "completed" },
      select: { clientId: true },
      distinct: ["clientId"],
    });
    let count = 0;
    for (const a of completed) {
      await this.computeForClient(a.clientId);
      count++;
    }
    void cfg;
    return count;
  }

  /**
   * Mark this client as opted out of future rebooking reminders.
   */
  async optOutClient(clientId: string): Promise<void> {
    await this.prisma.clientCadence.upsert({
      where: { clientId },
      create: {
        clientId,
        tenantId: (await this.prisma.client.findUnique({
          where: { id: clientId },
          select: { tenantId: true },
        }))!.tenantId,
        optedOut: true,
        nextRecommendedReminderAt: null,
        lastComputedAt: new Date(),
      },
      update: {
        optedOut: true,
        nextRecommendedReminderAt: null,
      },
    });
  }

  /**
   * Cancel all `scheduled` reminders for a (clientId, serviceId) pair and
   * mark them `cancelled` with the appointment id that preempted them.
   *
   * When `serviceId` is null we only cancel reminders that have NO service
   * attached (generic reminders). We intentionally do NOT match every row
   * for the client — cancelling unrelated service reminders would surprise
   * the recipient.
   */
  async cancelPending(
    clientId: string,
    serviceId: string | null,
    resultAppointmentId: string,
  ): Promise<number> {
    const where = serviceId
      ? { clientId, status: RebookStatus.scheduled, serviceId }
      : { clientId, status: RebookStatus.scheduled, serviceId: null };
    const result = await this.prisma.rebookingReminder.updateMany({
      where,
      data: {
        status: RebookStatus.cancelled,
        cancelledReason: "client_booked",
        resultAppointmentId,
      },
    });
    return result.count;
  }
}