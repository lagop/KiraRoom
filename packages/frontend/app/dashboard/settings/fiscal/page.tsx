"use client";

import { useEffect, useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import apiClient, { FiscalSettings, VerifactuStatus, ZeroRateTreatment } from "@/lib/api";
import { VerifactuCard } from "@/components/verifactu/verifactu-card";
import { Loader2, Save, Upload, ShieldOff, Lock } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import { pricesTaxExampleMessage } from "@/lib/prices-tax-example";
import {
  changedFiscalFields,
  fiscalChangeSummary,
  issuerFieldsFromSettings,
  ZERO_RATE_TREATMENTS,
  zeroRateMissing,
  zeroRateTreatmentFrom,
  type TaxIdType,
} from "@/lib/fiscal-settings-form";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { getCurrentUser } from "@/lib/utils";
import {
  TAX_REGIMES,
  TAX_REGIME_LABELS,
  TAX_REGIME_TERRITORIES,
  TAX_REGIME_DEFAULT_RATE,
  taxRegimeOf,
  type TaxRegime,
} from "@kira/shared";

/** The .p12 / .pfx file as base64, without the data: prefix. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });
}

export default function FiscalSettingsPage() {
  const t = useTranslations();
  const qc = useQueryClient();
  const { toast } = useToast();
  // PATCH settings/fiscal and the certificates are the owner's only
  // (invoices.controller.ts): an admin sees the settings read-only instead
  // of a Guardar that does nothing.
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? "");
  }, []);
  const isOwner = role === "owner";
  const readOnly = role !== null && !isOwner;

  const settings = useQuery<FiscalSettings>({
    queryKey: ["invoices", "fiscal-settings"],
    queryFn: () => apiClient.getFiscalSettings(),
  });
  const verifactu = useQuery<VerifactuStatus>({
    queryKey: ["verifactu", "status"],
    queryFn: () => apiClient.getVerifactuStatus(),
  });
  const certs = useQuery({
    queryKey: ["invoices", "certificates"],
    queryFn: () => apiClient.listFiscalCertificates(),
    enabled: isOwner,
  });

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof apiClient.updateFiscalSettings>[0]) =>
      apiClient.updateFiscalSettings(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices", "fiscal-settings"] });
      qc.invalidateQueries({ queryKey: ["verifactu"] });
      toast({ title: t("invoices.fiscalSettings.saved") });
    },
    onError: (err: unknown) =>
      toast({
        title: t("invoices.fiscalSettings.saveError"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const deactivateCert = useMutation({
    mutationFn: (id: string) => apiClient.deactivateFiscalCertificate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices", "certificates"] });
      qc.invalidateQueries({ queryKey: ["verifactu"] });
    },
    onError: (err: unknown) =>
      toast({
        title: t("invoices.fiscalSettings.certDeactivateError"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });
  const [confirmDeactivate, setConfirmDeactivate] = useState<{ id: string; alias: string } | null>(null);

  // Certificate upload: the .p12 / .pfx file and its password, as
  // UploadCertificateDto takes them (pkcs12Base64 + passphrase).
  const [certFile, setCertFile] = useState<File | null>(null);
  const [certAlias, setCertAlias] = useState("");
  const [certPassword, setCertPassword] = useState("");
  const [certSeal, setCertSeal] = useState(false);
  const [certInputKey, setCertInputKey] = useState(0);
  const uploadCert = useMutation({
    mutationFn: async () => {
      if (!certFile) throw new Error(t("invoices.fiscalSettings.certFileMissing"));
      return apiClient.uploadFiscalCertificate({
        alias: certAlias.trim() || certFile.name.replace(/\.(p12|pfx)$/i, ""),
        provider: "p12",
        pkcs12Base64: await fileToBase64(certFile),
        passphrase: certPassword,
        certificateType: certSeal ? "seal" : "personal",
      });
    },
    onSuccess: (saved) => {
      setCertFile(null);
      setCertAlias("");
      setCertPassword("");
      setCertSeal(false);
      setCertInputKey((k) => k + 1);
      qc.invalidateQueries({ queryKey: ["invoices", "certificates"] });
      qc.invalidateQueries({ queryKey: ["verifactu"] });
      toast({
        title: t("invoices.fiscalSettings.certUploaded"),
        description: saved.nifMatchesSalon === false ? t("invoices.fiscalSettings.certOtherNif") : undefined,
      });
    },
    onError: (err: unknown) =>
      toast({
        title: t("invoices.fiscalSettings.certUploadError"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  type Draft = {
    fiscalMode: FiscalSettings["fiscalMode"];
    defaultSeries: string;
    defaultTaxRate: number;
    autoInvoiceAppointments: boolean;
    diputacion: "bizkaia" | "gipuzkoa" | "alava" | null;
    taxRegime: TaxRegime;
    pricesIncludeTax: boolean;
    zeroRateTreatment: ZeroRateTreatment | undefined;
    tenantNif: string;
    taxIdType: TaxIdType;
    legalName: string;
  };
  const [draft, setDraft] = useState<Draft>({
    fiscalMode: "none",
    defaultSeries: "A",
    defaultTaxRate: 21,
    autoInvoiceAppointments: false,
    diputacion: null,
    taxRegime: "iva",
    pricesIncludeTax: false,
    zeroRateTreatment: undefined,
    tenantNif: "",
    taxIdType: "nif",
    legalName: "",
  });

  // What was loaded: a save sends only the fields that differ from it, so a
  // field nobody touched (the razón social, the ID type...) is never sent
  // back over what is stored.
  const [loaded, setLoaded] = useState<Draft | null>(null);
  // Changes to the NIF, the series, the regime or prices-include-tax are
  // confirmed first: what they change for the invoices from now on.
  const [confirmChanges, setConfirmChanges] = useState(false);

  useEffect(() => {
    if (settings.data) {
      const fs = settings.data.fiscalSettings ?? {};
      const next: Draft = {
        fiscalMode: settings.data.fiscalMode,
        defaultSeries: (fs.defaultSeries as string) ?? "A",
        defaultTaxRate: (fs.defaultTaxRate as number) ?? 21,
        autoInvoiceAppointments:
          (fs.autoInvoiceAppointments as boolean) ?? false,
        diputacion:
          (fs.diputacion as "bizkaia" | "gipuzkoa" | "alava" | null) ?? null,
        taxRegime: taxRegimeOf(fs),
        // Missing (a salon from before the setting): tax on top, as always.
        pricesIncludeTax: fs.pricesIncludeTax === true,
        zeroRateTreatment: zeroRateTreatmentFrom(fs),
        ...issuerFieldsFromSettings(settings.data),
      };
      setDraft(next);
      setLoaded(next);
    }
  }, [settings.data]);

  const changes = loaded ? changedFiscalFields(draft, loaded) : {};
  const hasChanges = Object.keys(changes).length > 0;
  const rateValid = Number.isFinite(draft.defaultTaxRate) && draft.defaultTaxRate >= 0 && draft.defaultTaxRate <= 100;
  const riskyChanges = loaded ? fiscalChangeSummary(draft, loaded) : [];

  const submit = () => {
    if (riskyChanges.length > 0) setConfirmChanges(true);
    else save.mutate(changes);
  };

  if (settings.isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  // "Un servicio de 30,00 € se factura como 24,79 € + 5,21 € de IVA", at
  // the rate and regime selected above, before saving.
  const priceExample = pricesTaxExampleMessage(
    rateValid ? draft.defaultTaxRate : 0,
    draft.pricesIncludeTax,
    TAX_REGIME_LABELS[draft.taxRegime],
  );

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

      {readOnly && (
        <p className="flex items-center gap-2 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700">
          <Lock className="h-4 w-4 shrink-0" />
          {t("invoices.fiscalSettings.ownerOnly")}
        </p>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <fieldset disabled={readOnly} className="space-y-5 disabled:opacity-80">
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
                <option value="passport">{t("invoices.fiscalSettings.taxIdPassport")}</option>
                <option value="other">{t("invoices.fiscalSettings.taxIdOther")}</option>
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
              placeholder={t("invoices.fiscalSettings.legalNamePlaceholder")}
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
                <option
                  key={m}
                  value={m}
                  disabled={m === "verifactu" ? !verifactu.data?.available : m !== "none"}
                >
                  {t(`invoices.fiscalMode.${m}`)}
                </option>
              ))}
            </select>
            {settings.data?.submissionAvailable === false && !verifactu.data?.available && (
              <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {t("invoices.fiscalSettings.submissionUnavailable")}
              </p>
            )}
            {verifactu.data?.available && (
              <p className="mt-2 text-xs text-gray-500">
                {t("invoices.verifactu.otherModes")}
              </p>
            )}
          </div>

          {draft.fiscalMode === "verifactu" && (
            <div>
              <label htmlFor="zero-rate" className="text-sm font-medium text-gray-900">
                {t("invoices.fiscalSettings.zeroRateLabel")}
              </label>
              <select
                id="zero-rate"
                value={draft.zeroRateTreatment ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    zeroRateTreatment: e.target.value as ZeroRateTreatment,
                  }))
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="" disabled>
                  {t("invoices.fiscalSettings.zeroRateChoose")}
                </option>
                {ZERO_RATE_TREATMENTS.map((option) => (
                  <option key={option} value={option}>
                    {t(`invoices.fiscalSettings.zeroRateOption.${option}`)}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                {t("invoices.fiscalSettings.zeroRateHint")}
              </p>
              {zeroRateMissing(draft) && (
                <p className="mt-1 text-xs text-red-600">{t("invoices.fiscalSettings.zeroRateMissing")}</p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-gray-900">
                {t("invoices.fiscalSettings.defaultSeries")}
              </label>
              <input
                type="text"
                maxLength={4}
                value={draft.defaultSeries}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, defaultSeries: e.target.value.toUpperCase() }))
                }
                className="mt-1 block w-32 rounded-md border border-gray-300 px-3 py-2 text-sm uppercase"
              />
              <p className="mt-1 text-xs text-gray-500">
                {t("invoices.fiscalSettings.defaultSeriesHint")}
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-900">
                {t("invoices.fiscalSettings.taxRegime")}
              </label>
              <select
                value={draft.taxRegime}
                onChange={(e) => {
                  const regime = e.target.value as TaxRegime;
                  // Switching regime without moving the rate would leave a
                  // Canarian salon invoicing at 21 %, which no IGIC rate
                  // matches. The backend does the same on save.
                  setDraft((d) => ({
                    ...d,
                    taxRegime: regime,
                    defaultTaxRate: TAX_REGIME_DEFAULT_RATE[regime],
                  }));
                }}
                className="mt-1 block w-64 rounded-md border border-gray-300 px-3 py-2 text-sm"
              >
                {TAX_REGIMES.map((r) => (
                  <option key={r} value={r}>
                    {TAX_REGIME_LABELS[r]} — {TAX_REGIME_TERRITORIES[r]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-500">
                {t("invoices.fiscalSettings.taxRegimeHint")}
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-900">
                {t("invoices.fiscalSettings.defaultTaxRate", {
                  tax: TAX_REGIME_LABELS[draft.taxRegime],
                })}
              </label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.01}
                value={Number.isFinite(draft.defaultTaxRate) ? draft.defaultTaxRate : ""}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    // Empty is not 0 %: it stays invalid until a rate is typed.
                    defaultTaxRate: e.target.value === "" ? Number.NaN : Number(e.target.value),
                  }))
                }
                className="mt-1 block w-32 rounded-md border border-gray-300 px-3 py-2 text-sm"
              />
              {!rateValid && (
                <p className="mt-1 text-xs text-red-600">{t("invoices.fiscalSettings.taxRateInvalid")}</p>
              )}
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-gray-900">
              <input
                type="checkbox"
                checked={draft.pricesIncludeTax}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    pricesIncludeTax: e.target.checked,
                  }))
                }
                className="h-4 w-4 rounded border-gray-300 text-violet-600"
              />
              <span>{t("invoices.fiscalSettings.pricesIncludeTax")}</span>
            </label>
            <p className="mt-1 pl-6 text-xs text-gray-500">
              {t(priceExample.key, priceExample.params)}.{" "}
              {t("invoices.fiscalSettings.pricesIncludeTaxHint")}
            </p>
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
        </fieldset>

        {!readOnly && (
          <div className="mt-6 flex justify-end">
            <button
              type="button"
              disabled={save.isPending || !hasChanges || !rateValid || zeroRateMissing(draft)}
              onClick={submit}
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
        )}
      </div>

      <VerifactuCard />

      {isOwner && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900">
            {t("invoices.fiscalSettings.certificates")}
          </h2>
          <p className="mt-1 text-sm text-gray-600">{t("invoices.fiscalSettings.certIntro")}</p>
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
                    onClick={() => setConfirmDeactivate({ id: c.id, alias: c.alias })}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                  >
                    <ShieldOff className="h-3 w-3" />
                    {t("invoices.fiscalSettings.deactivate")}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-gray-500">{t("invoices.fiscalSettings.certNone")}</p>
          )}

          <form
            className="mt-5 space-y-3 border-t border-gray-100 pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (certFile) uploadCert.mutate();
            }}
          >
            <h3 className="text-sm font-medium text-gray-900">{t("invoices.fiscalSettings.uploadCert")}</h3>
            <p className="text-xs text-gray-500">{t("invoices.fiscalSettings.uploadCertHint")}</p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <label htmlFor="cert-file" className="block text-xs font-medium text-gray-700">
                  {t("invoices.fiscalSettings.certFile")}
                </label>
                <input
                  key={certInputKey}
                  id="cert-file"
                  type="file"
                  accept=".p12,.pfx,application/x-pkcs12"
                  onChange={(e) => setCertFile(e.target.files?.[0] ?? null)}
                  className="mt-1 block w-full text-sm"
                />
              </div>
              <div>
                <label htmlFor="cert-password" className="block text-xs font-medium text-gray-700">
                  {t("invoices.fiscalSettings.certPassword")}
                </label>
                <input
                  id="cert-password"
                  type="password"
                  autoComplete="off"
                  value={certPassword}
                  onChange={(e) => setCertPassword(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label htmlFor="cert-alias" className="block text-xs font-medium text-gray-700">
                  {t("invoices.fiscalSettings.certAlias")}
                </label>
                <input
                  id="cert-alias"
                  type="text"
                  maxLength={100}
                  value={certAlias}
                  onChange={(e) => setCertAlias(e.target.value)}
                  placeholder={t("invoices.fiscalSettings.certAliasPlaceholder")}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={certSeal} onChange={(e) => setCertSeal(e.target.checked)} className="h-4 w-4" />
              {t("invoices.fiscalSettings.certSeal")}
            </label>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!certFile || uploadCert.isPending}
                className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {uploadCert.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {t("invoices.fiscalSettings.certUploadCta")}
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={confirmChanges}
        title={t("invoices.fiscalSettings.confirmTitle")}
        description={
          <div className="space-y-2">
            <p>{t("invoices.fiscalSettings.confirmIntro")}</p>
            <ul className="list-disc space-y-1 pl-5">
              {riskyChanges.map((line) => (
                <li key={line.key}>{t(line.key, line.params)}</li>
              ))}
            </ul>
          </div>
        }
        confirmLabel={t("invoices.fiscalSettings.confirmCta")}
        cancelLabel={t("common.cancel")}
        loading={save.isPending}
        onCancel={() => setConfirmChanges(false)}
        onConfirm={() => save.mutate(changes, { onSettled: () => setConfirmChanges(false) })}
      />

      <ConfirmDialog
        open={!!confirmDeactivate}
        title={t("invoices.fiscalSettings.certDeactivateTitle", { alias: confirmDeactivate?.alias ?? "" })}
        description={t("invoices.fiscalSettings.certDeactivateBody")}
        confirmLabel={t("invoices.fiscalSettings.deactivate")}
        cancelLabel={t("common.cancel")}
        destructive
        loading={deactivateCert.isPending}
        onCancel={() => setConfirmDeactivate(null)}
        onConfirm={() =>
          confirmDeactivate &&
          deactivateCert.mutate(confirmDeactivate.id, { onSettled: () => setConfirmDeactivate(null) })
        }
      />
    </div>
  );
}
