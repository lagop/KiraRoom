"use client";

import type { ReactNode } from "react";
import { Calendar, Star, TrendingUp, Users, type LucideIcon } from "lucide-react";
import { formatRate } from "@/lib/analytics-format";
import type { ClientInsights, Translate } from "../analytics-types";
import { ChartCard, EmptyState, InfoHint, InlineError, LoadingBlock } from "./ui";

/** Clientas (Pro): new, served and recurring clients over the page's period. */
export function ClientsTab({
  t,
  insights,
  loading,
  error,
  onRetry,
}: {
  t: Translate;
  insights: ClientInsights | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <ChartCard
      title={t("analytics.client_insights")}
      headingId="analytics-clients-heading"
      busy={loading && !!insights}
      busyLabel={t("analytics.updating")}
    >
      {error ? (
        <InlineError message={error} retryLabel={t("analytics.retry")} onRetry={onRetry} />
      ) : loading && !insights ? (
        <LoadingBlock className="h-32" />
      ) : insights ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <ClientStat
            tone="bg-indigo-50"
            icon={Users}
            iconTone="text-indigo-600"
            badge={<span className="text-xs bg-indigo-100 text-indigo-800 px-2 py-1 rounded-full">{t("analytics.new")}</span>}
            value={insights.newClients}
            label={t("analytics.new_clients")}
            hint={t("analytics.new_clients_hint")}
            hintLabel={t("analytics.what_counts", { metric: t("analytics.new_clients") })}
          />
          {/* Recurring = served in the period (≥1 completed appointment) and
              came back within it or had come before (API: clientRetention). */}
          <ClientStat
            tone="bg-blue-50"
            icon={Star}
            iconTone="text-blue-600"
            badge={<span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">{t("analytics.returning")}</span>}
            value={
              <>
                {insights.returningClients}
                <span className="text-base font-normal text-gray-500"> / {insights.clientsServed}</span>
              </>
            }
            label={t("analytics.returning_clients")}
            footnote={t("analytics.returning_hint")}
          />
          <ClientStat
            tone="bg-green-50"
            icon={Calendar}
            iconTone="text-green-600"
            value={insights.clientsServed}
            label={t("analytics.clients_served")}
            hint={t("analytics.clients_served_hint")}
            hintLabel={t("analytics.what_counts", { metric: t("analytics.clients_served") })}
            footnote={`${insights.totalAppointments} ${t("analytics.appointments").toLowerCase()}`}
          />
          <ClientStat
            tone="bg-purple-50"
            icon={TrendingUp}
            iconTone="text-purple-600"
            value={formatRate(insights.retentionRate)}
            label={t("analytics.retention_rate")}
            footnote={t("analytics.retention_hint")}
          />
        </div>
      ) : (
        <EmptyState text={t("analytics.no_client_insights")} />
      )}
    </ChartCard>
  );
}

function ClientStat({
  tone,
  icon: Icon,
  iconTone,
  badge,
  value,
  label,
  hint,
  hintLabel,
  footnote,
}: {
  tone: string;
  icon: LucideIcon;
  iconTone: string;
  badge?: ReactNode;
  value: ReactNode;
  label: string;
  /** Behind an info button when the footnote is not the definition. */
  hint?: string;
  hintLabel?: string;
  /** Visible under the label. */
  footnote?: string;
}) {
  return (
    <div className={`${tone} rounded-lg p-4 sm:p-6`}>
      <div className="flex items-center justify-between mb-2">
        <Icon className={`w-5 h-5 ${iconTone}`} aria-hidden />
        {badge}
      </div>
      <p className="text-3xl font-bold text-gray-900">{value}</p>
      <p className="text-sm text-gray-600 flex items-center gap-1">
        {label}
        {hint && hintLabel && <InfoHint label={hintLabel} text={hint} />}
      </p>
      {footnote && <p className="text-xs text-gray-500 mt-2">{footnote}</p>}
    </div>
  );
}
