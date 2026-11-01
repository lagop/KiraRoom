"use client";

import { Calendar, DollarSign, ShoppingBag, TrendingUp, Users, Wallet, type LucideIcon } from "lucide-react";
import { formatCents, formatPercentChange } from "@/lib/analytics-format";
import type { DashboardStats, TillSales, Translate } from "../analytics-types";
import { InfoHint } from "./ui";

type ChangeType = "positive" | "negative" | "neutral";

/** "+12,5 % vs. mismo período anterior", or "—" when there is nothing to compare. */
function changeLine(t: Translate, change: number | null | undefined): { change: string; changeType: ChangeType } {
  return change === null || change === undefined
    ? { change: `— ${t("analytics.no_previous_data")}`, changeType: "neutral" }
    : {
        change: `${formatPercentChange(change)} ${t("analytics.vs_previous_period")}`,
        changeType: change >= 0 ? "positive" : "negative",
      };
}

/** Ingresos, citas, nuevas clientas and valor medio, against the previous period. */
export function StatsGrid({ t, stats }: { t: Translate; stats: DashboardStats }) {
  // "X de Y citas cobradas": the appointments behind Ingresos and the
  // average, so unpaid visits are visible (older API answers lack it).
  const paidLine =
    typeof stats.paidAppointments === "number"
      ? t("analytics.paid_of_total", { paid: stats.paidAppointments, total: stats.totalAppointments })
      : undefined;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        t={t}
        title={t("analytics.appointment_revenue")}
        value={formatCents(stats.totalRevenue)}
        hint={t("analytics.revenue_hint")}
        detail={paidLine}
        icon={DollarSign}
        {...changeLine(t, stats.revenueChange)}
      />
      <StatCard
        t={t}
        title={t("analytics.total_appointments")}
        value={stats.totalAppointments.toString()}
        hint={t("analytics.appointments_hint")}
        icon={Calendar}
        {...changeLine(t, stats.appointmentsChange)}
      />
      <StatCard
        t={t}
        title={t("analytics.new_clients")}
        value={stats.newClients.toString()}
        hint={t("analytics.new_clients_hint")}
        icon={Users}
        {...changeLine(t, stats.clientsChange)}
      />
      <StatCard
        t={t}
        title={t("analytics.avg_order_value")}
        value={formatCents(stats.avgOrderValue)}
        hint={t("analytics.avg_ticket_hint")}
        detail={paidLine}
        icon={TrendingUp}
        {...changeLine(t, stats.orderValueChange)}
      />
    </div>
  );
}

/**
 * S6: what the till sold without an appointment (products and services, VAT
 * included, net of refunds), and "Ingresos + caja", the appointments'
 * revenue and the till together. Ingresos de citas stays on its own card.
 * With a location chosen, the till holds only its professionals' services.
 */
export function TillSalesRow({
  t,
  stats,
  tillSales,
  byLocation,
}: {
  t: Translate;
  stats: DashboardStats;
  tillSales: TillSales;
  byLocation: boolean;
}) {
  const parts = [
    `${t("analytics.till_services")}: ${formatCents(tillSales.servicesCents)}`,
    ...(byLocation ? [] : [`${t("analytics.till_products")}: ${formatCents(tillSales.productsCents)}`]),
  ];
  const refunds =
    tillSales.refundedCents > 0 ? t("analytics.till_refunded", { amount: formatCents(tillSales.refundedCents) }) : null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <StatCard
        t={t}
        title={t("analytics.till_sales")}
        value={formatCents(tillSales.totalCents)}
        hint={byLocation ? t("analytics.till_sales_location_hint") : t("analytics.till_sales_hint")}
        detail={[parts.join(" · "), t("analytics.till_sales_count", { sales: tillSales.sales })].join(" · ")}
        icon={ShoppingBag}
        change={refunds ?? ""}
        changeType="neutral"
      />
      <StatCard
        t={t}
        title={t("analytics.revenue_with_till")}
        value={formatCents(stats.totalRevenueWithTill)}
        hint={t("analytics.revenue_with_till_hint")}
        detail={t("analytics.revenue_with_till_detail", {
          appointments: formatCents(stats.totalRevenue),
          till: formatCents(tillSales.totalCents),
        })}
        icon={Wallet}
        change=""
        changeType="neutral"
      />
    </div>
  );
}

export function StatCard({
  t,
  title,
  value,
  icon: Icon,
  change,
  changeType,
  hint,
  detail,
}: {
  t: Translate;
  title: string;
  value: string;
  icon: LucideIcon;
  /** The comparison line; empty for none. */
  change: string;
  /** "neutral" when there is nothing to compare with. */
  changeType: ChangeType;
  /** What the figure counts, behind the info button. */
  hint?: string;
  /** A sub-line under the value, e.g. "12 de 15 citas cobradas". */
  detail?: string;
}) {
  const tone = {
    positive: { icon: "text-green-500", text: "text-green-600" },
    negative: { icon: "text-red-500", text: "text-red-600" },
    neutral: { icon: "text-gray-400", text: "text-gray-500" },
  }[changeType];
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-gray-500 flex items-center gap-1">
          {title}
          {hint && <InfoHint label={t("analytics.what_counts", { metric: title })} text={hint} />}
        </h3>
        <Icon className={`w-5 h-5 ${tone.icon}`} aria-hidden />
      </div>
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      {detail && <div className="text-xs text-gray-500 mt-1">{detail}</div>}
      {change && <div className={`text-sm mt-2 ${tone.text}`}>{change}</div>}
    </div>
  );
}
