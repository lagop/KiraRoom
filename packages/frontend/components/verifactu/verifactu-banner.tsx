"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import apiClient, { VerifactuStatus } from "@/lib/api";
import { pollVerifactuStatus } from "@/lib/fiscal-settings-form";
import { useTranslations } from "@/lib/use-translation";

/**
 * Orden HAC/1177/2024 art. 16.4: while invoices cannot be sent to the AEAT
 * because of an incident, the system must say so, with how many are
 * waiting, for as long as any is. Shown on every page of the panel.
 */
export function VerifactuBanner() {
  const t = useTranslations();
  const { data } = useQuery<VerifactuStatus>({
    queryKey: ["verifactu", "status"],
    queryFn: () => apiClient.getVerifactuStatus(),
    refetchInterval: pollVerifactuStatus(60_000),
    retry: false,
  });
  // Not gated on `active`: a salon that left still has its queue to clear.
  if (!data) return null;
  const waiting = data.pending > 0 && (data.incidentSince || data.lastError);
  if (!waiting && data.rejected === 0 && !data.zeroRateAssumed) return null;

  return (
    <div
      role="status"
      className={`mb-4 flex items-start gap-2 rounded-md border px-4 py-3 text-sm ${
        waiting || data.rejected === 0 ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-900"
      }`}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        {waiting ? (
          <>
            {t(data.pending === 1 ? "invoices.verifactu.bannerOne" : "invoices.verifactu.bannerMany", { count: data.pending })}
            {data.incidentSince
              ? ` ${t("invoices.verifactu.since", {
                  date: new Date(data.incidentSince).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }),
                })}`
              : ""}
            . {t("invoices.verifactu.retrying")}. {t("invoices.verifactu.keepInvoicing")}
          </>
        ) : data.rejected > 0 ? (
          t(data.rejected === 1 ? "invoices.verifactu.bannerRejectedOne" : "invoices.verifactu.bannerRejectedMany", {
            count: data.rejected,
          })
        ) : (
          t(data.zeroRateAssumed === 1 ? "invoices.verifactu.bannerZeroRateOne" : "invoices.verifactu.bannerZeroRateMany", {
            count: data.zeroRateAssumed,
          })
        )}{" "}
        <a href="/dashboard/settings/fiscal" className="font-medium underline">
          {t("invoices.verifactu.details")}
        </a>
      </div>
    </div>
  );
}
