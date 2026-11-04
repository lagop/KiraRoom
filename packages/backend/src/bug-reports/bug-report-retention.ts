import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { BugReportStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { runUnscoped } from "../common/tenancy/tenant.context";
import { MonitoredJob } from "../common/ops-alerts/ops-alert-sink";

/**
 * Bug-report retention (audit 8 D14, owner decision 2026-11-04).
 *
 * The free text often names clients ("no puedo mover la cita de María
 * López, 6xx…"), and a report also keeps the author's email, the page URL
 * and a context blob. They were kept forever, even after the salon was
 * anonymised. Now:
 *
 *   - 12 months after a report is closed (resolved / wont_fix / duplicate,
 *     dated by resolvedAt), its personal data is removed;
 *   - when a salon is anonymised (GdprService.anonymize, which the retention
 *     job also uses), its reports lose it at the same time.
 *
 * The row stays, without that data, so the triage history (status,
 * resolution, dates) still counts.
 */
export const BUG_REPORT_RETENTION_MONTHS = 12;

export const CLOSED_BUG_REPORT_STATUSES: BugReportStatus[] = ["resolved", "wont_fix", "duplicate"];

const REMOVED = "[eliminado]";

/** What a report keeps once its personal data is removed. */
export function strippedBugReportData(now: Date): Prisma.BugReportUpdateManyMutationInput {
  return {
    subject: REMOVED,
    description: REMOVED,
    email: null,
    currentUrl: null,
    context: {},
    anonymizedAt: now,
  };
}

/** Closed before this instant: its personal data is due for removal. */
export function bugReportRetentionCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - BUG_REPORT_RETENTION_MONTHS);
  return cutoff;
}

@Injectable()
export class BugReportRetentionScheduler {
  private readonly logger = new Logger(BugReportRetentionScheduler.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron("15 4 * * *")
  @MonitoredJob("BugReportRetentionScheduler.daily")
  async daily(): Promise<number> {
    return this.purge(new Date());
  }

  /** Removes the personal data of reports closed more than 12 months ago. Returns how many. */
  async purge(now: Date = new Date()): Promise<number> {
    const res = await runUnscoped(() =>
      this.prisma.bugReport.updateMany({
        where: {
          status: { in: CLOSED_BUG_REPORT_STATUSES },
          resolvedAt: { lt: bugReportRetentionCutoff(now) },
          anonymizedAt: null,
        },
        data: strippedBugReportData(now),
      }),
    );
    if (res.count > 0) this.logger.log(`Bug-report retention: personal data removed from ${res.count} report(s)`);
    return res.count;
  }
}
