"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import apiClient from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";
import { isManager } from "@/lib/dashboard-nav";
import { useTranslations } from "@/lib/use-translation";
import { issuerBannerState, issuerBlockDate, issuerLinks, joinList } from "@/lib/invoice-issuer";

/**
 * The warning for the owner and admins when the salon is missing the data
 * every invoice needs as its issuer (NIF, razón social, fiscal address), with
 * links to where each is filled in. Shown on the dashboard, Facturas and the
 * till. Nothing for staff, nor once the data is complete.
 */
export function IssuerDataBanner({ className = "" }: { className?: string }) {
  const t = useTranslations();
  const [role, setRole] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, []);
  const manager = isManager(role);
  const status = useQuery({
    queryKey: ["invoices", "issuer-status"],
    queryFn: () => apiClient.getInvoiceIssuerStatus(),
    enabled: manager,
    staleTime: 60_000,
  });

  const state = manager ? issuerBannerState(status.data) : "none";
  if (state === "none" || !status.data) return null;

  const fields = joinList(
    status.data.missing.map((f) => t(`invoices.issuerBanner.fields.${f}`)),
    t("invoices.issuerBanner.and"),
  );
  const blocking = state === "blocking";
  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${
        blocking ? "border-red-200 bg-red-50 text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"
      } ${className}`}
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">{t("invoices.issuerBanner.title")}</p>
        <p>
          {t("invoices.issuerBanner.missing", { fields })}{" "}
          {state === "blocking"
            ? t("invoices.issuerBanner.blocking")
            : state === "scheduled"
              ? t("invoices.issuerBanner.scheduled", { date: issuerBlockDate(status.data.blockFrom ?? "") })
              : t("invoices.issuerBanner.warn")}
        </p>
        <p className="flex flex-wrap gap-x-4 gap-y-1">
          {issuerLinks(status.data.missing).map((link) => (
            <Link key={link.href} href={link.href} className="font-medium underline hover:no-underline">
              {t(`invoices.issuerBanner.${link.label}`)}
            </Link>
          ))}
        </p>
      </div>
    </div>
  );
}
