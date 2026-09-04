"use client";

import { useEffect, useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import apiClient, { FiscalSettings } from "@/lib/api";
import { Loader2, Save, Upload, ShieldOff } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";

export default function FiscalSettingsPage() {
  const t = useTranslations();
  const qc = useQueryClient();
  const settings = useQuery<FiscalSettings>({
    queryKey: ["invoices", "fiscal-settings"],
    queryFn: () => apiClient.getFiscalSettings(),
  });
  const certs = useQuery({
    queryKey: ["invoices", "certificates"],
    queryFn: () => apiClient.listFiscalCertificates(),
  });

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof apiClient.updateFiscalSettings>[0]) =>
      apiClient.updateFiscalSettings(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices", "fiscal-settings"] }),
  });

  const deactivateCert = useMutation({
    mutationFn: (id: string) => apiClient.deactivateFiscalCertificate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices", "certificates"] }),
  });

  const [draft, setDraft] = useState<{
    fiscalMode: FiscalSettings["fiscalMode"];
    defaultSeries: string;
    defaultTaxRate: number;
    autoInvoiceAppointments: boolean;
    diputacion: "bizkaia" | "gipuzkoa" | "alava" | null;
    tenantNif: string;
    taxIdType: "nif" | "cif" | "nie" | "passport" | "other";
    legalName: string;
  }>({
    fiscalMode: "none",
    defaultSeries: "A",
    defaultTaxRate: 21,
    autoInvoiceAppointments: false,
    diputacion: null,
    tenantNif: "",
    taxIdType: "nif",
    legalName: "",
  });

  useEffect(() => {
    if (settings.data) {
      const fs = settings.data.fiscalSettings ?? {};
      setDraft({
        fiscalMode: settings.data.fiscalMode,
        defaultSeries: (fs.defaultSeries as string) ?? "A",
        defaultTaxRate: (fs.defaultTaxRate as number) ?? 21,
        autoInvoiceAppointments:
          (fs.autoInvoiceAppointments as boolean) ?? false,
        diputacion:
          (fs.diputacion as "bizkaia" | "gipuzkoa" | "alava" | null) ?? null,
        tenantNif:
          (fs.tenantNif as string) ??
          (settings.data.taxId as string | undefined) ??
          "",
        taxIdType:
          (settings.data.taxIdType as
            | "nif" | "cif" | "nie" | "passport" | "other"
            | undefined) ?? "nif",
        legalName: (settings.data.legalName as string) ?? "",
      });
    }
  }, [settings.data]);

  if (settings.isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">
          {t("invoices.fiscalSettings.title")}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {t("invoices.fiscalSettings.subtitle")}
        </p>
      </header>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="space-y-5">
          <div>
            <label className="text-sm font-medium text-gray-900">
              {t("invoices.fiscalSettings.taxIdLabel")}
            </label>
            <div className="mt-1 flex gap-2">
              <select
                value={draft.taxIdType}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    taxIdType: e.target
                      .value as typeof d.taxIdType,
                  }))
                }
                className="rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="nif">NIF</option>
                <option value="cif">CIF</option>
                <option value="nie">NIE</option>
                <option value="passport">Pasaporte</option>
                <option value="other">Otro</option>
              </select>
              <input
                type="text"
                value={draft.tenantNif}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    tenantNif: e.target.value.toUpperCase(),
                  }))
                }
                placeholder="B12345678"
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm uppercase"
              />
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {t("invoices.fiscalSettings.taxIdHint")}
            </p>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-900">
              {t("invoices.fiscalSettings.legalName")}
            </label>
            <input
              type="text"
              value={draft.legalName}
              onChange={(e) =>
                setDraft((d) => ({ ...d, legalName: e.target.value }))
              }
              placeholder="Razón social del emisor"
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-gray-900">
              {t("invoices.fiscalSettings.mode")}
            </label>
            <select
              value={draft.fiscalMode}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  fiscalMode: e.target
                    .value as FiscalSettings["fiscalMode"],
                }))
              }
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              {(
                [
                  "none",
                  "verifactu",
                  "ticketbai",
                  "sii_only",
                ] as const
              ).map((m) => (
                <option key={m} value={m}>
                  {t(`invoices.fiscalMode.${m}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-gray-900">
                {t("invoices.fiscalSettings.defaultSeries")}
              </label>
              <input
                type="text"
                maxLength={2}
                value={draft.defaultSeries}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, defaultSeries: e.target.value }))
                }
                className="mt-1 block w-32 rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-900">
                {t("invoices.fiscalSettings.defaultTaxRate")}
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={draft.defaultTaxRate}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    defaultTaxRate: Number(e.target.value),
                  }))
                }
                className="mt-1 block w-32 rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.autoInvoiceAppointments}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  autoInvoiceAppointments: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-gray-300 text-violet-600"
            />
            <span>{t("invoices.fiscalSettings.autoInvoiceAppointments")}</span>
          </label>

          {draft.fiscalMode === "ticketbai" && (
            <div>
              <label className="text-sm font-medium text-gray-900">
                {t("invoices.fiscalSettings.diputacion")}
              </label>
              <select
                value={draft.diputacion ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    diputacion:
                      (e.target.value as
                        | "bizkaia"
                        | "gipuzkoa"
                        | "alava"
                        | "") || null,
                  }))
                }
                className="mt-1 block w-64 rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">—</option>
                <option value="bizkaia">
                  {t("invoices.fiscalSettings.diputacionBizkaia")}
                </option>
                <option value="gipuzkoa">
                  {t("invoices.fiscalSettings.diputacionGipuzkoa")}
                </option>
                <option value="alava">
                  {t("invoices.fiscalSettings.diputacionAlava")}
                </option>
              </select>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate(draft)}
            className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
          >
            {save.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t("invoices.actions.save")}
          </button>
        </div>
        {save.isSuccess && (
          <p className="mt-2 text-right text-xs text-green-600">
            {t("invoices.fiscalSettings.saved")}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">
          {t("invoices.fiscalSettings.certificates")}
        </h2>
        {certs.data && certs.data.length > 0 ? (
          <ul className="mt-3 space-y-2">
            {certs.data.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between rounded-md border border-gray-200 p-3 text-sm"
              >
                <div>
                  <div className="font-medium">{c.alias}</div>
                  <div className="text-xs text-gray-500">
                    {t("invoices.fiscalSettings.certFingerprint")}:{" "}
                    {c.fingerprint.slice(0, 16)}...
                  </div>
                  {c.notAfter && (
                    <div className="text-xs text-gray-500">
                      {t("invoices.fiscalSettings.certNotAfter")}:{" "}
                      {new Date(c.notAfter).toLocaleDateString("es-ES")}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => deactivateCert.mutate(c.id)}
                  className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                >
                  <ShieldOff className="h-3 w-3" />
                  {t("invoices.fiscalSettings.deactivate")}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">—</p>
        )}
        <p className="mt-4 rounded-md bg-amber-50 p-3 text-xs text-amber-800">
          {t("invoices.fiscalSettings.uploadCert")}: use the API endpoint{" "}
          <code>POST /invoices/certificates</code> with the encrypted PEM and
          fingerprint. The UI upload flow is intentionally a future iteration
          so we can review the encryption pipeline first.
        </p>
      </div>
    </div>
  );
}