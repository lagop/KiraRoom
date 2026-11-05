"use client";

import { BarChart3 } from "lucide-react";
import { barWidth } from "@/lib/analytics-charts";
import { formatCents } from "@/lib/analytics-format";
import type { ServicePopularity, TopService, Translate } from "../analytics-types";
import { Bar, ChartCard, EmptyState, InfoHint } from "./ui";

/** Share of bookings per service (the API's percentage, cancelled excluded). */
export function ServicePopularityCard({ t, rows }: { t: Translate; rows: ServicePopularity[] }) {
  return (
    <ChartCard
      title={t("analytics.service_popularity")}
      headingId="analytics-services-heading"
      aside={<BarChart3 className="w-5 h-5 text-gray-400" aria-hidden />}
    >
      {rows.length > 0 ? (
        <ul className="space-y-4">
          {rows.map((service, i) => (
            <li key={`${i}-${service.name}`}>
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-sm font-medium text-gray-700 min-w-0 break-words">{service.name}</span>
                <span className="text-sm text-gray-500 whitespace-nowrap">
                  {service.count} {t("analytics.appointments")}
                </span>
              </div>
              <Bar width={service.percentage} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState text={t("analytics.no_data_available")} className="py-4" />
      )}
    </ChartCard>
  );
}

/** "Servicios que más facturan": paid revenue per service, by revenue. */
export function TopServicesCard({ t, rows }: { t: Translate; rows: TopService[] }) {
  const title = t("analytics.top_services_revenue");
  const max = Math.max(...rows.map((r) => r.revenue), 1);
  const withRevenue = rows.filter((r) => r.revenue > 0);
  return (
    <ChartCard
      title={
        <>
          {title}
          <InfoHint label={t("analytics.what_counts", { metric: title })} text={t("analytics.top_services_hint")} />
        </>
      }
      headingId="analytics-top-services-heading"
    >
      {withRevenue.length > 0 ? (
        <ol className="space-y-4">
          {withRevenue.map((service, i) => (
            <li key={`${i}-${service.name}`}>
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-sm font-medium text-gray-700 min-w-0 break-words">{service.name}</span>
                <span className="text-sm font-medium text-gray-900 whitespace-nowrap">
                  {formatCents(service.revenue)}
                </span>
              </div>
              <Bar width={barWidth(service.revenue, max)} color="#059669" />
              <p className="text-xs text-gray-500 mt-1">
                {service.count} {t("analytics.appointments").toLowerCase()}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState text={t("analytics.no_data_available")} className="py-4" />
      )}
    </ChartCard>
  );
}
