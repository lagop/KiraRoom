import { Injectable } from "@nestjs/common";
import { BugReportStatus } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { runUnscoped } from "../../common/tenancy/tenant.context";
import { escapeHtml } from "../../common/html-escape";
import { appBaseUrl } from "../../common/app-base-url";
import { salonToday } from "../../analytics/analytics-metrics";
import { usagePeriod } from "../../common/telemetry/llm-usage.service";
import { estimateCostUsd } from "../../virtual-receptionist/providers/anthropic-models";
import { DAY_MS, RETENTION_FLAG, retentionEnabled, retentionStep } from "../retention/salon-retention";
import { CONSOLE_TIME_ZONE } from "../platform-metrics";
import { COUNTABLE_TENANT_WHERE } from "../saas.constants";

/**
 * "Esta semana" (audit 8 D12, owner decision): what the platform owner has
 * to look at, on one console page, a block of the home page, and the Monday
 * email (WeeklyDigestScheduler). Only salons that count (COUNTABLE_TENANT_WHERE:
 * not deleted, not internal).
 */
export interface WeeklyDigest {
  generatedAt: string;
  /** ISO week on the Madrid calendar, e.g. 2026-W45. */
  week: string;
  pastDue: { id: string; name: string; paymentFailedAt: string | null; gracePeriodEndsAt: string | null }[];
  trialsEnding: { id: string; name: string; trialEnd: string; hasSubscription: boolean }[];
  deletionRequests: { id: string; name: string; deletionRequestedAt: string }[];
  retention: {
    /** RETENTION_ANONYMIZE_ENABLED: off means a dry run, nothing is done. */
    enabled: boolean;
    items: { id: string; name: string; kind: "warn" | "anonymize"; anonymizeOn: string; dueNow: boolean }[];
  };
  aiSpend: {
    /** YYYY-MM, UTC (how tenant_llm_usage is kept). */
    period: string;
    totalUsd: number;
    /** Models without a known price (their cost is not in the totals). */
    unpricedModels: string[];
    salons: { id: string; name: string; calls: number; outputTokens: number; usd: number }[];
  };
  onboardingStuck: { id: string; name: string; createdAt: string; days: number }[];
  openBugReports: {
    count: number;
    latest: { id: string; subject: string; status: BugReportStatus; createdAt: string; tenantName: string | null }[];
  };
}

export const WEEKLY_LIST_LIMIT = 20;
const OPEN_BUG_STATUSES: BugReportStatus[] = ["open", "triaged", "in_progress"];

/** ISO-8601 week of a calendar day "YYYY-MM-DD", e.g. "2026-W45". */
export function isoWeek(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7; // Monday 1 .. Sunday 7
  date.setUTCDate(date.getUTCDate() + 4 - dow); // the week's Thursday
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The Madrid ISO week `now` falls in. */
export function consoleWeek(now: Date = new Date()): string {
  return isoWeek(salonToday(CONSOLE_TIME_ZONE, now));
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

@Injectable()
export class WeeklyDigestService {
  constructor(private readonly prisma: PrismaService) {}

  async build(now: Date = new Date()): Promise<WeeklyDigest> {
    const in7 = new Date(now.getTime() + 7 * DAY_MS);
    const ago7 = new Date(now.getTime() - 7 * DAY_MS);
    const period = usagePeriod(now);

    const [pastDue, trials, deletions, retentionCandidates, usage, stuck, bugCount, bugs] = await runUnscoped(() =>
      Promise.all([
        this.prisma.tenant.findMany({
          where: { ...COUNTABLE_TENANT_WHERE, subscriptionStatus: "past_due" },
          select: { id: true, name: true, paymentFailedAt: true, gracePeriodEndsAt: true },
          orderBy: { gracePeriodEndsAt: "asc" },
          take: WEEKLY_LIST_LIMIT,
        }),
        this.prisma.tenant.findMany({
          where: { ...COUNTABLE_TENANT_WHERE, subscriptionStatus: "trialing", trialEnd: { gte: now, lte: in7 } },
          select: { id: true, name: true, trialEnd: true, stripeSubscriptionId: true },
          orderBy: { trialEnd: "asc" },
          take: WEEKLY_LIST_LIMIT,
        }),
        this.prisma.tenant.findMany({
          where: { ...COUNTABLE_TENANT_WHERE, deletionRequestedAt: { not: null } },
          select: { id: true, name: true, deletionRequestedAt: true },
          orderBy: { deletionRequestedAt: "asc" },
          take: WEEKLY_LIST_LIMIT,
        }),
        // The same candidates as SalonRetentionScheduler.run.
        this.prisma.tenant.findMany({
          where: {
            ...COUNTABLE_TENANT_WHERE,
            subscriptionStatus: { in: ["cancelled", "suspended"] },
            readOnlyUntil: { not: null },
            anonymizedAt: null,
          },
          select: {
            id: true,
            name: true,
            subscriptionStatus: true,
            readOnlyUntil: true,
            anonymizationWarnedAt: true,
            anonymizationWarnedFor: true,
          },
          orderBy: { readOnlyUntil: "asc" },
          take: 200,
        }),
        this.prisma.tenantLlmUsage.findMany({ where: { period } }),
        this.prisma.tenant.findMany({
          where: {
            ...COUNTABLE_TENANT_WHERE,
            subscriptionStatus: { in: ["trialing", "active", "past_due"] },
            createdAt: { lt: ago7 },
            OR: [{ onboardingState: null }, { onboardingState: { finishedAt: null } }],
          },
          select: { id: true, name: true, createdAt: true },
          orderBy: { createdAt: "asc" },
          take: WEEKLY_LIST_LIMIT,
        }),
        this.prisma.bugReport.count({ where: { status: { in: OPEN_BUG_STATUSES } } }),
        this.prisma.bugReport.findMany({
          where: { status: { in: OPEN_BUG_STATUSES } },
          select: { id: true, subject: true, status: true, createdAt: true, tenant: { select: { name: true } } },
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
      ]),
    );

    // Retention: what tonight's run would do, then what comes due within
    // the week (the SalonRetention rules, evaluated a week ahead).
    const retentionItems: WeeklyDigest["retention"]["items"] = [];
    for (const t of retentionCandidates) {
      const nowStep = retentionStep(t, now);
      const step = nowStep ?? retentionStep(t, in7);
      if (!step) continue;
      retentionItems.push({
        id: t.id,
        name: t.name,
        kind: step.kind,
        anonymizeOn: step.anonymizeOn.toISOString(),
        dueNow: !!nowStep,
      });
    }

    // AI spend this month, per counted salon.
    const counted = await runUnscoped(() =>
      this.prisma.tenant.findMany({
        where: { ...COUNTABLE_TENANT_WHERE, id: { in: [...new Set(usage.map((u) => u.tenantId))] } },
        select: { id: true, name: true },
      }),
    );
    const names = new Map(counted.map((t) => [t.id, t.name]));
    const perSalon = new Map<string, { calls: number; outputTokens: number; usd: number }>();
    const unpriced = new Set<string>();
    for (const u of usage) {
      if (!names.has(u.tenantId)) continue;
      const usd = estimateCostUsd(u.model, {
        promptTokens: Number(u.inputTokens),
        completionTokens: Number(u.outputTokens),
        cachedInputTokens: Number(u.cachedInputTokens),
        cacheWriteTokens: Number(u.cacheWriteTokens),
      });
      if (usd === null) unpriced.add(`${u.provider}/${u.model}`);
      const row = perSalon.get(u.tenantId) ?? { calls: 0, outputTokens: 0, usd: 0 };
      row.calls += u.calls;
      row.outputTokens += Number(u.outputTokens);
      row.usd += usd ?? 0;
      perSalon.set(u.tenantId, row);
    }
    const salons = [...perSalon.entries()]
      .map(([id, r]) => ({ id, name: names.get(id) ?? id, ...r, usd: Math.round(r.usd * 100) / 100 }))
      .sort((a, b) => b.usd - a.usd || b.outputTokens - a.outputTokens);

    return {
      generatedAt: now.toISOString(),
      week: consoleWeek(now),
      pastDue: pastDue.map((t) => ({
        id: t.id,
        name: t.name,
        paymentFailedAt: iso(t.paymentFailedAt),
        gracePeriodEndsAt: iso(t.gracePeriodEndsAt),
      })),
      trialsEnding: trials.map((t) => ({
        id: t.id,
        name: t.name,
        trialEnd: t.trialEnd!.toISOString(),
        hasSubscription: !!t.stripeSubscriptionId,
      })),
      deletionRequests: deletions.map((t) => ({
        id: t.id,
        name: t.name,
        deletionRequestedAt: t.deletionRequestedAt!.toISOString(),
      })),
      retention: { enabled: retentionEnabled(process.env[RETENTION_FLAG]), items: retentionItems },
      aiSpend: {
        period,
        totalUsd: Math.round(salons.reduce((s, r) => s + r.usd, 0) * 100) / 100,
        unpricedModels: [...unpriced].sort(),
        salons: salons.slice(0, WEEKLY_LIST_LIMIT),
      },
      onboardingStuck: stuck.map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt.toISOString(),
        days: Math.floor((now.getTime() - t.createdAt.getTime()) / DAY_MS),
      })),
      openBugReports: {
        count: bugCount,
        latest: bugs.map((b) => ({
          id: b.id,
          subject: b.subject,
          status: b.status,
          createdAt: b.createdAt.toISOString(),
          tenantName: b.tenant?.name ?? null,
        })),
      },
    };
  }
}

const day = (s: string | null) =>
  s ? new Date(s).toLocaleDateString("es-ES", { timeZone: CONSOLE_TIME_ZONE, day: "numeric", month: "short" }) : "—";

/** Subject + HTML + text of the Monday email. Every value from the database is escaped. */
export function renderWeeklyDigestEmail(d: WeeklyDigest): { subject: string; html: string; text: string } {
  const base = appBaseUrl();
  const salon = (id: string, name: string) => `<a href="${base}/saas/tenants/${escapeHtml(id)}">${escapeHtml(name)}</a>`;
  const sections: { title: string; empty: string; html: string[]; text: string[] }[] = [
    {
      title: `Pagos fallidos (${d.pastDue.length})`,
      empty: "Ninguno.",
      html: d.pastDue.map((t) => `${salon(t.id, t.name)}: falló el ${day(t.paymentFailedAt)}, gracia hasta el ${day(t.gracePeriodEndsAt)}`),
      text: d.pastDue.map((t) => `${t.name}: falló el ${day(t.paymentFailedAt)}, gracia hasta el ${day(t.gracePeriodEndsAt)}`),
    },
    {
      title: `Pruebas que acaban en 7 días (${d.trialsEnding.length})`,
      empty: "Ninguna.",
      html: d.trialsEnding.map((t) => `${salon(t.id, t.name)}: ${day(t.trialEnd)}${t.hasSubscription ? " (ya tiene suscripción)" : ""}`),
      text: d.trialsEnding.map((t) => `${t.name}: ${day(t.trialEnd)}${t.hasSubscription ? " (ya tiene suscripción)" : ""}`),
    },
    {
      title: `Borrados pedidos (${d.deletionRequests.length})`,
      empty: "Ninguno.",
      html: d.deletionRequests.map((t) => `${salon(t.id, t.name)}: pedido el ${day(t.deletionRequestedAt)}`),
      text: d.deletionRequests.map((t) => `${t.name}: pedido el ${day(t.deletionRequestedAt)}`),
    },
    {
      title: `Retención${d.retention.enabled ? "" : " (ensayo: está apagada, no se hace nada)"} (${d.retention.items.length})`,
      empty: "Nada esta semana.",
      html: d.retention.items.map(
        (r) => `${salon(r.id, r.name)}: ${r.kind === "warn" ? "aviso al salón" : "anonimizar"}${r.dueNow ? " (esta noche)" : ""}, anonimización el ${day(r.anonymizeOn)}`,
      ),
      text: d.retention.items.map(
        (r) => `${r.name}: ${r.kind === "warn" ? "aviso al salón" : "anonimizar"}${r.dueNow ? " (esta noche)" : ""}, anonimización el ${day(r.anonymizeOn)}`,
      ),
    },
    {
      title: `Gasto de IA en ${d.aiSpend.period}: ${d.aiSpend.totalUsd.toFixed(2)} USD (estimado)`,
      empty: "Sin uso.",
      html: d.aiSpend.salons.map((s) => `${salon(s.id, s.name)}: ${s.usd.toFixed(2)} USD, ${s.calls} llamadas`),
      text: d.aiSpend.salons.map((s) => `${s.name}: ${s.usd.toFixed(2)} USD, ${s.calls} llamadas`),
    },
    {
      title: `Arranque sin terminar tras 7 días (${d.onboardingStuck.length})`,
      empty: "Ninguno.",
      html: d.onboardingStuck.map((t) => `${salon(t.id, t.name)}: ${t.days} días`),
      text: d.onboardingStuck.map((t) => `${t.name}: ${t.days} días`),
    },
    {
      title: `Reportes de bugs sin resolver (${d.openBugReports.count})`,
      empty: "Ninguno.",
      html: d.openBugReports.latest.map((b) => `${escapeHtml(b.subject)}${b.tenantName ? ` (${escapeHtml(b.tenantName)})` : ""}, ${day(b.createdAt)}`),
      text: d.openBugReports.latest.map((b) => `${b.subject}${b.tenantName ? ` (${b.tenantName})` : ""}, ${day(b.createdAt)}`),
    },
  ];

  const html = `<!DOCTYPE html><html lang="es"><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#0f172a">
<h2>KiraRoom, esta semana (${escapeHtml(d.week)})</h2>
${sections
  .map(
    (s) =>
      `<h3 style="margin-bottom:4px">${escapeHtml(s.title)}</h3>${
        s.html.length ? `<ul>${s.html.map((l) => `<li>${l}</li>`).join("")}</ul>` : `<p style="color:#64748b">${s.empty}</p>`
      }`,
  )
  .join("\n")}
<p><a href="${base}/saas/weekly">Ver en la consola</a></p>
<p style="color:#64748b;font-size:12px">Resumen automático de los lunes. No cuentan los salones eliminados ni los internos o de prueba (marcados en la consola).</p>
</body></html>`;
  const text = [
    `KiraRoom, esta semana (${d.week})`,
    ...sections.map((s) => `\n${s.title}\n${s.text.length ? s.text.map((l) => `- ${l}`).join("\n") : s.empty}`),
    `\n${base}/saas/weekly`,
  ].join("\n");
  const urgent = d.pastDue.length + d.deletionRequests.length + d.retention.items.filter((r) => r.dueNow).length;
  return {
    subject: `[KiraRoom] Esta semana (${d.week})${urgent > 0 ? `: ${urgent} cosa(s) que mirar` : ""}`,
    html,
    text,
  };
}
