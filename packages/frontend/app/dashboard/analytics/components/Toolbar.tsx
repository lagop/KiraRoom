"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import apiClient from "@/lib/api";
import { formatPeriod } from "@/lib/analytics-format";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/components/ui/use-toast";
import type { SalonLocation, Translate } from "../analytics-types";

const SELECT_CLASS =
  "text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500";

/**
 * Empresa: the page for the whole salon or one location (D12). Closed
 * locations stay in the list, marked, so their history can still be read.
 */
export function LocationSelector({
  t,
  locations,
  value,
  onChange,
}: {
  t: Translate;
  locations: SalonLocation[];
  value: string | null;
  onChange: (locationId: string | null) => void;
}) {
  if (locations.length === 0) return null;
  return (
    <>
      <label htmlFor="analytics-location" className="sr-only">
        {t("analytics.location_label")}
      </label>
      <select
        id="analytics-location"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className={SELECT_CLASS}
      >
        <option value="">{t("analytics.all_locations")}</option>
        {locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.isActive ? l.name : t("analytics.location_closed", { name: l.name })}
          </option>
        ))}
      </select>
    </>
  );
}

/** Saves a downloaded file under its name. */
function saveFile(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

type ExportKind = "appointments" | "payments";

/**
 * S3: the period's appointments (by visit day) and payments (by the day they
 * were charged) as CSV, through the exports the panel already has. Exports
 * are always the whole salon's: they have no location filter.
 */
export function ExportMenu({
  t,
  period,
  filteredByLocation,
}: {
  t: Translate;
  period: { start: string; end: string };
  filteredByLocation: boolean;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<ExportKind | null>(null);

  const download = async (kind: ExportKind) => {
    setBusy(kind);
    try {
      const { blob, filename } =
        kind === "appointments"
          ? await apiClient.downloadAppointmentsCsv(period.start, period.end)
          : await apiClient.downloadPaymentsCsv({ dateFrom: period.start, dateTo: period.end });
      saveFile(blob, filename);
    } catch (error) {
      toast({
        title: t("analytics.export_error"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const item = (kind: ExportKind, label: string) => (
    <button
      type="button"
      onClick={() => download(kind)}
      disabled={busy !== null}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60"
    >
      {busy === kind ? (
        <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
      ) : (
        <Download className="w-4 h-4 text-gray-400" aria-hidden />
      )}
      {label}
    </button>
  );

  return (
    <Popover>
      <PopoverTrigger
        type="button"
        className="flex items-center px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg bg-white hover:bg-gray-50"
      >
        <Download className="w-4 h-4 mr-2" aria-hidden />
        {t("analytics.export")}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-2rem)] bg-white p-2">
        <p className="px-3 pt-1 pb-2 text-xs text-gray-500">
          {t("analytics.export_period", { period: formatPeriod(period) })}
        </p>
        {item("appointments", t("analytics.export_appointments"))}
        {item("payments", t("analytics.export_payments"))}
        {filteredByLocation && (
          <p className="px-3 pt-2 text-xs text-gray-500">{t("analytics.export_whole_salon")}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
