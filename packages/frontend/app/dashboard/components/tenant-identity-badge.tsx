"use client";

import { useQuery } from "@tanstack/react-query";
import apiClient, { FiscalSettings } from "@/lib/api";
import { ShieldCheck } from "lucide-react";

/**
 * Read-only display of the tenant's emitter tax ID. Sources from the
 * same fiscal settings endpoint as `/dashboard/settings/salon`, so the
 * value in the badge always matches what's persisted.
 *
 * Hidden when `taxId` is empty (e.g., during onboarding before the
 * SaaS admin has set it).
 */
export function TenantIdentityBadge() {
  const settings = useQuery<FiscalSettings>({
    queryKey: ["invoices", "fiscal-settings"],
    queryFn: () => apiClient.getFiscalSettings(),
    staleTime: 60_000,
  });

  const taxId = settings.data?.fiscalSettings?.tenantNif;
  const taxIdType = settings.data?.fiscalSettings?.defaultTaxRate
    ? undefined
    : undefined;

  if (!taxId) return null;

  return (
    <span
      title={`NIF del emisor: ${taxId}`}
      aria-label={`NIF del emisor: ${taxId}`}
      className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2 sm:px-2.5 py-1 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-200 flex-shrink-0"
    >
      <ShieldCheck className="h-3 w-3 flex-shrink-0" />
      <span className="hidden sm:inline">NIF:</span>
      <span className="truncate max-w-[8rem] sm:max-w-none">{taxId}</span>
    </span>
  );
}
