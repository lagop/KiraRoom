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
/** Clients read per page when a whole salon is recomputed. */
export const TENANT_RECOMPUTE_PAGE = 200;

/**
 * The channel a rebooking reminder goes out on. Only email delivers today,
 * so "whatsapp" and "both" (and anything else) are email.
 */
export function rebookingChannelOf(_stored: unknown): "email" {
  return "email";
}

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
      // Email only: WhatsApp is not wired for these reminders, and a salon
      // that had picked "WhatsApp" or "Email y WhatsApp" silently stopped
      // getting any sent. Those salons send by email now
      // (rebookingChannelOf); the stored value is left as it was.
      channelFallback: rebookingChannelOf(raw.channelFallback),
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
   * Refreshes the cadence of every client of the tenant with a completed
   * visit, so a change of "días de antelación" or "mínimo de visitas" reaches
   * the clients the salon already has, not only those who come back. Clients
   * are read in pages of TENANT_RECOMPUTE_PAGE (by id) and recomputed one at
   * a time, so a large salon neither loads every client at once nor floods
   * the database. The reminders already sent are kept (computeForClient), so
   * no client gets a second email for the same visit cycle.
   */
  async computeForTenant(tenantId: string): Promise<number> {
    let count = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.client.findMany({
        where: { tenantId, appointments: { some: { status: "completed" } } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: TENANT_RECOMPUTE_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const c of page) {
        try {
          await this.computeForClient(c.id);
          count++;
        } catch (err) {
          this.logger.warn(`Cadence recompute of client ${c.id} failed: ${(err as Error).message}`);
        }
      }
      if (page.length < TENANT_RECOMPUTE_PAGE) break;
      cursor = page[page.length - 1].id;
    }
    return count;
  }

  /** Tenants whose recompute is running, and those asked for again meanwhile. */
  private readonly recomputing = new Set<string>();
  private readonly recomputeAgain = new Set<string>();

  /**
   * Runs computeForTenant without making the caller wait (the settings save
   * answers at once). One run per tenant at a time: a save during a run asks
   * for one more run after it, with the settings saved last.
   */
  recomputeTenantInBackground(tenantId: string): Promise<void> {
    if (this.recomputing.has(tenantId)) {
      this.recomputeAgain.add(tenantId);
      return Promise.resolve();
    }
    this.recomputing.add(tenantId);
    const run = async (): Promise<void> => {
      try {
        do {
          this.recomputeAgain.delete(tenantId);
          const n = await this.computeForTenant(tenantId);
          this.logger.log(`Rebooking cadences recomputed for tenant ${tenantId}: ${n} clients`);
        } while (this.recomputeAgain.has(tenantId));
      } catch (err) {
        this.logger.warn(`Rebooking recompute for tenant ${tenantId} failed: ${(err as Error).message}`);
      } finally {
        this.recomputing.delete(tenantId);
        this.recomputeAgain.delete(tenantId);
      }
    };
    return run();
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