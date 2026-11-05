import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { OnboardingGroup } from "@prisma/client";
import { createHmac, timingSafeEqual } from "crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import { runUnscoped } from "../common/tenancy/tenant.context";
import { EmailService } from "../notifications/services/email.service";
import { OnboardingService } from "./onboarding.service";
import { appBaseUrl } from "../common/app-base-url";
import { MonitoredJob } from "../common/ops-alerts/ops-alert-sink";

const HOUR_MS = 3_600_000;
/** Day 2 after signup: from 48 hours, for one day (the job runs hourly). */
export const NUDGE_AFTER_HOURS = 48;
export const NUDGE_WINDOW_HOURS = 24;
const BATCH = 100;
const SIGNATURE_CHARS = 32;

/**
 * The mandatory steps in Spanish, as the panel's checklist names them
 * (messages/es.json onboarding.*.title), with where to do each.
 */
const STEP_LABELS: Record<string, string> = {
  workspace_business: "Los datos de tu salón: nombre, dirección y teléfono",
  service_create: "Tu primer servicio",
  schedule_set: "El horario de tu equipo",
};

export interface MissingStep {
  key: string;
  label: string;
  url: string;
}

/**
 * Audit 7 D17: one email to the owner on day 2 after signup, only when a
 * mandatory onboarding step (OnboardingGroup.linear_required) is still
 * missing, naming what is missing with a link to each.
 *
 * - Once per salon: claimed by a conditional update on
 *   Tenant.onboardingNudgeSentAt, so a second run or instance never sends it
 *   again; a failed email gives the claim back for the next hour.
 * - Nothing missing in the 24 hours of day 2: nothing is sent, ever.
 * - It is a tip from KiraRoom, so it carries a one-click unsubscribe (RFC 8058
 *   and a footer link): a token signed with a key derived from JWT_SECRET,
 *   naming the user; unsubscribing sets User.productTipsOptOutAt, which this
 *   job respects.
 */
@Injectable()
export class OnboardingNudgeService {
  private readonly logger = new Logger(OnboardingNudgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly onboarding: OnboardingService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  @Cron("25 * * * *")
  @MonitoredJob("OnboardingNudgeService.hourly")
  async hourly(): Promise<number> {
    try {
      return await this.run(new Date());
    } catch (err) {
      this.logger.error(`Onboarding reminders failed: ${(err as Error).message}`);
      return 0;
    }
  }

  /** Returns how many were sent. */
  async run(now: Date = new Date()): Promise<number> {
    const from = new Date(now.getTime() - (NUDGE_AFTER_HOURS + NUDGE_WINDOW_HOURS) * HOUR_MS);
    const to = new Date(now.getTime() - NUDGE_AFTER_HOURS * HOUR_MS);
    const tenants: Array<{ id: string; name: string }> = await runUnscoped(() =>
      this.prisma.tenant.findMany({
        where: {
          createdAt: { gt: from, lte: to },
          onboardingNudgeSentAt: null,
          deletedAt: null,
          // Audit 8 D5: a salon blocked from the console gets nothing.
          blockedAt: null,
          subscriptionStatus: { in: ["trialing", "active"] },
        },
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
        take: BATCH,
      }),
    );
    let sent = 0;
    for (const t of tenants) {
      try {
        if (await this.nudge(t, now)) sent += 1;
      } catch (err) {
        this.logger.warn(`Onboarding reminder for ${t.id} failed: ${(err as Error).message}`);
      }
    }
    if (sent) this.logger.log(`Onboarding reminders: ${sent} sent`);
    return sent;
  }

  /** The mandatory steps still missing (the detectors are the truth). */
  async missingSteps(tenantId: string): Promise<MissingStep[]> {
    const state = await runUnscoped(() => this.onboarding.getState(tenantId));
    const base = this.appBase();
    return state.defs
      .filter((d: any) => d.group === OnboardingGroup.linear_required)
      .filter((d: any) => !state.detectResults[d.key] && state.steps[d.key]?.status !== "done")
      .map((d: any) => ({
        key: d.key,
        label: STEP_LABELS[d.key] ?? d.key,
        url: `${base}${d.href || "/dashboard"}`,
      }));
  }

  private async nudge(t: { id: string; name: string }, now: Date): Promise<boolean> {
    const missing = await this.missingSteps(t.id);
    if (missing.length === 0) return false;

    const owner = await runUnscoped(() =>
      this.prisma.user.findFirst({
        where: { tenantId: t.id, role: "owner", isActive: true },
        select: { id: true, email: true, firstName: true, productTipsOptOutAt: true },
      }),
    );
    if (!owner?.email || owner.productTipsOptOutAt) return false;

    const claimed = await runUnscoped(() =>
      this.prisma.tenant.updateMany({
        where: { id: t.id, onboardingNudgeSentAt: null },
        data: { onboardingNudgeSentAt: now },
      }),
    );
    if (claimed.count !== 1) return false;

    const token = this.tokenFor(owner.id);
    const result = await this.email.sendOnboardingReminder({
      to: owner.email,
      firstName: owner.firstName ?? null,
      tenantName: t.name,
      missing,
      unsubscribeUrl: this.pageUrl(token),
      headers: this.unsubscribeHeaders(token),
    });
    if (!result.success) {
      if (!result.skipped) {
        await runUnscoped(() =>
          this.prisma.tenant.updateMany({
            where: { id: t.id, onboardingNudgeSentAt: now },
            data: { onboardingNudgeSentAt: null },
          }),
        );
        throw new Error(`email not sent: ${result.error}`);
      }
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------ unsubscribe

  tokenFor(userId: string): string {
    const payload = Buffer.from(`t.${userId}`).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  /** The user a token names, or null when it is malformed or not ours. */
  parse(token: string): string | null {
    const [payload, signature, extra] = String(token ?? "").split(".");
    if (!payload || !signature || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const decoded = Buffer.from(payload, "base64url").toString();
    if (!decoded.startsWith("t.")) return null;
    const id = decoded.slice(2);
    return id || null;
  }

  /** What the page shows before the owner confirms. Null: not a valid link. */
  async describe(token: string): Promise<{ unsubscribed: boolean } | null> {
    const userId = this.parse(token);
    if (!userId) return null;
    const user = await runUnscoped(() =>
      this.prisma.user.findUnique({ where: { id: userId }, select: { productTipsOptOutAt: true } }),
    );
    return user ? { unsubscribed: !!user.productTipsOptOutAt } : null;
  }

  /** No more tips for this user. Idempotent. Null: not a valid link. */
  async unsubscribe(token: string, now: Date = new Date()): Promise<{ unsubscribed: true } | null> {
    const userId = this.parse(token);
    if (!userId) return null;
    const done = await runUnscoped(() =>
      this.prisma.user.updateMany({
        where: { id: userId, productTipsOptOutAt: null },
        data: { productTipsOptOutAt: now },
      }),
    );
    if (done.count === 0) {
      const exists = await runUnscoped(() => this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }));
      if (!exists) return null;
    }
    return { unsubscribed: true };
  }

  private pageUrl(token: string): string {
    return `${this.appBase()}/public/baja-consejos/${encodeURIComponent(token)}`;
  }

  /** RFC 8058 one-click: a POST to the API; without API_BASE_URL, the page. */
  private unsubscribeHeaders(token: string): Record<string, string> {
    const apiBase = this.config.get<string>("API_BASE_URL")?.trim().replace(/\/+$/, "");
    return apiBase
      ? {
          "List-Unsubscribe": `<${apiBase}/api/v1/public/email/tips-unsubscribe/${token}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : { "List-Unsubscribe": `<${this.pageUrl(token)}>` };
  }

  private appBase(): string {
    return appBaseUrl((k) => this.config.get<string>(k));
  }

  private sign(payload: string): string {
    const secret = this.config.get<string>("JWT_SECRET");
    if (!secret) throw new Error("JWT_SECRET is required to sign unsubscribe links");
    // A key of its own, so a signature here is valid nowhere else.
    const key = createHmac("sha256", secret).update("product-tips-unsubscribe:v1").digest();
    return createHmac("sha256", key).update(payload).digest("base64url").slice(0, SIGNATURE_CHARS);
  }
}
