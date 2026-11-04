"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { TAX_REGIME_LABELS, taxRegimeOf } from "@kira/shared";
import apiClient from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";
import { isManager } from "@/lib/dashboard-nav";
import { useTranslations } from "@/lib/use-translation";

/**
 * The notice for the owner and admins when the salon's address is in the
 * Canary Islands, Ceuta or Melilla but it invoices with another tax (audit 7
 * N6). A new salon is switched to IGIC or IPSI on its own while it has issued
 * no invoice; after that the owner decides, in Ajustes fiscales.
 */
export function TerritoryTaxNotice({ className = "" }: { className?: string }) {
  const t = useTranslations();
  const [role, setRole] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, []);
  const manager = isManager(role);
  const settings = useQuery({
    // The fiscal page's own query: saving there refreshes this.
    queryKey: ["invoices", "fiscal-settings"],
    queryFn: () => apiClient.getFiscalSettings(),
    enabled: manager,
    staleTime: 60_000,
  });

  const territory = manager ? settings.data?.territoryTaxRegime : null;
  if (!territory || !settings.data) return null;
  const current = TAX_REGIME_LABELS[taxRegimeOf(settings.data.fiscalSettings)];
  return (
    <div
      role="status"
      data-test="territory-tax-notice"
      className={`flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 ${className}`}
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="space-y-1">
        <p className="font-medium">{t("invoices.territoryTaxNotice.title")}</p>
        <p>{t(`invoices.territoryTaxNotice.${territory}`, { current })}</p>
        <p>
          <Link href="/dashboard/settings/fiscal" className="font-medium underline hover:no-underline">
            {t("invoices.territoryTaxNotice.link")}
          </Link>
        </p>
      </div>
    </div>
  );
}
