import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { GdprRequestStatus } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { runUnscoped } from "../../common/tenancy/tenant.context";
import { EmailService } from "../../notifications/services/email.service";
import { GdprService } from "../gdpr/gdpr.service";
import { PlatformRetentionConfigService } from "../../platform/platform-retention-config.service";
import { RetentionCandidate, RetentionStep, retentionStep } from "./salon-retention";
import { MonitoredJob, reportJobFailure } from "../../common/ops-alerts/ops-alert-sink";

/** Who the GdprRequest of an automatic anonymisation names as its actor (not a user id). */
export const RETENTION_ACTOR = "system:retention";

const BATCH = 200;

export interface RetentionRun {
  /** False: a dry run, nothing written and no email sent (the console switch off). */
  enabled: boolean;
  warned: string[];
  anonymized: string[];
  /** What a dry run would have done. */
  wouldWarn: string[];
  wouldAnonymize: string[];
  failed: string[];
}

/**
 * The retention job (salon-retention.ts): daily, for every read-only salon,
 * warns the owner 7 days before its data is anonymised, and anonymises it
 * 60 days after its trial or subscription ended.
 *
 * Behind the console switch (Ajustes de la plataforma > Retención de datos,
 * PlatformRetentionConfigService; off by default). The env var
 * RETENTION_ANONYMIZE_ENABLED=true also turns it on, as an override, so a
 * server that already relies on it keeps working. Off, it only logs what it
 * would do, so the first runs can be watched. On:
 * - the warning is claimed by a conditional update (the readOnlyUntil it is
 *   for), so two instances or a second run never send it twice; a failed
 *   email gives the claim back for the next day;
 * - the anonymisation is claimed the same way (anonymizedAt, on the
 *   readOnlyUntil it read), recorded as a GdprRequest and run by
 *   GdprService.anonymize with the invoices kept. A failure marks the request
 *   failed and gives the claim back.
 * Salons deleted from the console are picked up too (audit 8 D3): deleting
 * follows the same 60 days as "Borrar mi salón", and their owner is warned
 * without the links her team can no longer use. anonymizedAt, set by the
 * anonymisation, is what keeps a salon from being picked up again.
 */
@Injectable()
export class SalonRetentionScheduler {
  private readonly logger = new Logger(SalonRetentionScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gdpr: GdprService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly retentionConfig: PlatformRetentionConfigService,
  ) {}

  /** 04:40 UTC, after the 04:00 billing jobs that start the read-only periods. */
  @Cron("40 4 * * *")
  @MonitoredJob("SalonRetentionScheduler.daily")
  async daily(): Promise<RetentionRun> {
    try {
      return await this.run(new Date());
    } catch (err) {
      // Caught to return an empty run, so report it here (audit 8 D15).
      await reportJobFailure("SalonRetentionScheduler.daily", err);
      return { enabled: false, warned: [], anonymized: [], wouldWarn: [], wouldAnonymize: [], failed: [] };
    }
  }

  async run(now: Date = new Date()): Promise<RetentionRun> {
    const enabled = await this.retentionConfig.isEnabled();
    const out: RetentionRun = { enabled, warned: [], anonymized: [], wouldWarn: [], wouldAnonymize: [], failed: [] };

    const candidates: Array<RetentionCandidate & { name: string; deletedAt?: Date | null }> = await runUnscoped(() =>
      this.prisma.tenant.findMany({
        where: {
          subscriptionStatus: { in: ["cancelled", "suspended"] },
          readOnlyUntil: { not: null },
          anonymizedAt: null,
        },
        select: {
          id: true,
          name: true,
          subscriptionStatus: true,
          deletedAt: true,
          readOnlyUntil: true,
          anonymizationWarnedAt: true,
          anonymizationWarnedFor: true,
        },
        orderBy: { readOnlyUntil: "asc" },
        take: BATCH,
      }),
    );

    for (const t of candidates) {
      const step = retentionStep(t, now);
      if (!step) continue;
      const day = step.anonymizeOn.toISOString().slice(0, 10);
      if (!enabled) {
        if (step.kind === "warn") out.wouldWarn.push(t.id);
        else out.wouldAnonymize.push(t.id);
        this.logger.log(
          `[dry run, retention switch off] would ${step.kind === "warn" ? `warn the owner of` : "anonymise"} ${t.name} (${t.id}), read-only until ${t.readOnlyUntil!.toISOString()}, anonymisation on ${day}`,
        );
        continue;
      }
      try {
        if (step.kind === "warn") {
          if (await this.warn(t, step, now)) out.warned.push(t.id);
        } else if (await this.anonymize(t, now)) {
          out.anonymized.push(t.id);
        }
      } catch (err) {
        out.failed.push(t.id);
        this.logger.error(`Retention ${step.kind} for ${t.id} failed: ${(err as Error).message}`);
      }
    }

    if (out.warned.length || out.anonymized.length || out.failed.length) {
      this.logger.log(
        `Retention: ${out.warned.length} warned, ${out.anonymized.length} anonymised, ${out.failed.length} failed`,
      );
    } else if (out.wouldWarn.length || out.wouldAnonymize.length) {
      this.logger.log(
        `Retention dry run: would warn ${out.wouldWarn.length}, would anonymise ${out.wouldAnonymize.length}. Turn retention on in the console to act.`,
      );
    }
    return out;
  }

  private async warn(t: RetentionCandidate & { name: string; deletedAt?: Date | null }, step: RetentionStep, now: Date): Promise<boolean> {
    const claimed = await runUnscoped(() =>
      this.prisma.tenant.updateMany({
        where: {
          id: t.id,
          readOnlyUntil: t.readOnlyUntil,
          anonymizedAt: null,
          OR: [{ anonymizationWarnedFor: null }, { anonymizationWarnedFor: { not: t.readOnlyUntil } }],
        },
        data: { anonymizationWarnedAt: now, anonymizationWarnedFor: t.readOnlyUntil },
      }),
    );
    if (claimed.count !== 1) return false;

    const owner = await runUnscoped(() =>
      this.prisma.user.findFirst({ where: { tenantId: t.id, role: "owner" }, select: { email: true } }),
    );
    const base = (this.config.get<string>("APP_BASE_URL") || this.config.get<string>("FRONTEND_URL") || "https://app.kiraroom.net").replace(/\/+$/, "");
    const sent = owner?.email
      ? await this.email.sendAnonymizationWarning({
          to: owner.email,
          tenantName: t.name,
          anonymizeOn: step.anonymizeOn,
          exportUrl: `${base}/dashboard/settings/seguridad`,
          billingUrl: `${base}/dashboard/billing`,
          deleted: !!t.deletedAt,
        })
      : { success: false, error: "no owner email" };
    if (!sent.success && !(sent as { skipped?: boolean }).skipped) {
      // Not warned: the claim goes back, and the anonymisation waits for a
      // warning that reached the owner (or bounced for good).
      await runUnscoped(() =>
        this.prisma.tenant.updateMany({
          where: { id: t.id, anonymizationWarnedAt: now },
          data: { anonymizationWarnedAt: null, anonymizationWarnedFor: null },
        }),
      );
      throw new Error(`warning email not sent: ${sent.error}`);
    }
    this.logger.log(`Retention: warned the owner of ${t.name} (${t.id}); anonymisation on ${step.anonymizeOn.toISOString().slice(0, 10)}`);
    return true;
  }

  private async anonymize(t: RetentionCandidate & { name: string }, now: Date): Promise<boolean> {
    const claimed = await runUnscoped(() =>
      this.prisma.tenant.updateMany({
        where: {
          id: t.id,
          anonymizedAt: null,
          readOnlyUntil: t.readOnlyUntil,
          subscriptionStatus: { in: ["cancelled", "suspended"] },
        },
        data: { anonymizedAt: now },
      }),
    );
    if (claimed.count !== 1) return false;

    const request = await runUnscoped(() =>
      this.prisma.gdprRequest.create({
        data: {
          tenantId: t.id,
          action: "anonymize",
          status: GdprRequestStatus.processing,
          actorId: RETENTION_ACTOR,
          notes: `Automatic: read-only until ${t.readOnlyUntil!.toISOString()}, 60 days after the end`,
        },
      }),
    );
    try {
      await runUnscoped(() => this.gdpr.anonymize(t.id, request.id, { keepFiscalData: true }));
    } catch (err) {
      await runUnscoped(() =>
        this.prisma.gdprRequest.update({
          where: { id: request.id },
          data: { status: GdprRequestStatus.failed, notes: `Failed: ${(err as Error).message}`.slice(0, 500) },
        }),
      ).catch(() => undefined);
      await runUnscoped(() =>
        this.prisma.tenant.updateMany({ where: { id: t.id, anonymizedAt: now }, data: { anonymizedAt: null } }),
      ).catch(() => undefined);
      throw err;
    }
    this.logger.warn(`Retention: anonymised ${t.id} (request ${request.id}); invoices kept`);
    return true;
  }
}
