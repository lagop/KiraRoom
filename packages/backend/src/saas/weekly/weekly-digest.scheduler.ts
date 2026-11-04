import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EmailService } from "../../notifications/services/email.service";
import { MonitoredJob } from "../../common/ops-alerts/ops-alert-sink";
import { opsAlertRecipient } from "../../common/ops-alerts/ops-alert.service";
import { CONSOLE_TIME_ZONE } from "../platform-metrics";
import { consoleWeek, renderWeeklyDigestEmail, WeeklyDigestService } from "./weekly-digest.service";

export const weeklyDigestTask = (week: string) => `weekly-digest:${week}`;

/**
 * The Monday email of "Esta semana" (audit 8 D12): 08:00 Europe/Madrid to
 * OPS_ALERT_EMAIL (else FOUNDER_EMAIL, else admin@kiraroom.net).
 *
 * Once per ISO week: the run claims a maintenance_tasks row named
 * weekly-digest:YYYY-Www (unique), so a second instance or a restart sends
 * nothing. The cron also fires every hour until 20:00 on Mondays: when the
 * 08:00 run did not happen (deploy, crash) or the send failed (the claim is
 * released), a later hour catches up.
 */
@Injectable()
export class WeeklyDigestScheduler {
  private readonly logger = new Logger(WeeklyDigestScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly digest: WeeklyDigestService,
    private readonly email: EmailService,
  ) {}

  @Cron("0 8-20 * * 1", { timeZone: CONSOLE_TIME_ZONE })
  @MonitoredJob("WeeklyDigestScheduler.monday")
  async monday(): Promise<boolean> {
    return this.sendWeek(new Date());
  }

  /** Sends this week's digest unless it already went out. True when sent now. */
  async sendWeek(now: Date = new Date()): Promise<boolean> {
    const name = weeklyDigestTask(consoleWeek(now));
    try {
      await this.prisma.maintenanceTask.create({ data: { name, completedAt: now } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
      throw err;
    }
    try {
      const digest = await this.digest.build(now);
      const mail = renderWeeklyDigestEmail(digest);
      const res = await this.email.sendEmail({ to: opsAlertRecipient(), ...mail, idempotencyKey: name });
      if (!res?.success) throw new Error(`weekly digest not sent: ${res?.error ?? "unknown error"}`);
      await this.prisma.maintenanceTask.update({
        where: { name },
        data: {
          result: {
            pastDue: digest.pastDue.length,
            trialsEnding: digest.trialsEnding.length,
            deletionRequests: digest.deletionRequests.length,
            retention: digest.retention.items.length,
            onboardingStuck: digest.onboardingStuck.length,
            openBugReports: digest.openBugReports.count,
          },
        },
      });
      this.logger.log(`Weekly digest ${name} sent`);
      return true;
    } catch (err) {
      // Release the claim so a later hour retries; @MonitoredJob alerts.
      await this.prisma.maintenanceTask.delete({ where: { name } }).catch(() => undefined);
      throw err;
    }
  }
}
