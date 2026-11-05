"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileKey } from "lucide-react";
import apiClient, { VerifactuStatus } from "@/lib/api";
import { pollVerifactuStatus } from "@/lib/fiscal-settings-form";
import { useTranslations } from "@/lib/use-translation";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }) : "";

/**
 * VERI*FACTU in the fiscal settings: the state of the salon's queue at the
 * AEAT, and which certificate the invoices are sent with. The certificate is
 * uploaded and deactivated in the page's own section.
 */
export function VerifactuCard() {
  const t = useTranslations();
  const status = useQuery<VerifactuStatus>({
    queryKey: ["verifactu", "status"],
    queryFn: () => apiClient.getVerifactuStatus(),
    refetchInterval: pollVerifactuStatus(30_000),
  });

  const s = status.data;
  if (!s) return null;
  const waiting = s.pending > 0 && (s.incidentSince || s.lastError);
  // A salon that left keeps seeing what is still queued or was rejected.
  const showQueue = s.active || s.pending > 0 || s.rejected > 0;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">VERI*FACTU</h2>
        {s.available && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              s.environment === "production" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"
            }`}
          >
            {t(s.environment === "production" ? "invoices.verifactu.envProduction" : "invoices.verifactu.envTest")}
          </span>
        )}
      </div>

      {!s.available ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {t("invoices.verifactu.unavailable")}
        </p>
      ) : (
        <p className="text-sm text-gray-600">
          {t("invoices.verifactu.intro")}
        </p>
      )}

      {showQueue && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Count label={t("invoices.verifactu.accepted")} value={s.accepted} tone="green" />
          <Count label={t("invoices.verifactu.withWarnings")} value={s.acceptedWithErrors} tone="amber" />
          <Count label={t("invoices.verifactu.pending")} value={s.pending} tone={waiting ? "amber" : "gray"} />
          <Count label={t("invoices.verifactu.rejected")} value={s.rejected} tone={s.rejected ? "red" : "gray"} />
        </div>
      )}

      {waiting && (
        <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {t(s.pending === 1 ? "invoices.verifactu.waitingOne" : "invoices.verifactu.waitingMany", { count: s.pending })}
            {s.incidentSince ? ` ${t("invoices.verifactu.since", { date: when(s.incidentSince) })}` : ""}.{" "}
            {t("invoices.verifactu.retrying")}
            {s.nextSendAt ? ` (${t("invoices.verifactu.nextAttempt", { date: when(s.nextSendAt) })})` : ""}.{" "}
            {t("invoices.verifactu.keepInvoicing")}
            {s.lastError && <div className="mt-1 text-xs text-amber-800">{s.lastError}</div>}
          </div>
        </div>
      )}
      {s.rejected > 0 && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          {t(s.rejected === 1 ? "invoices.verifactu.rejectedOne" : "invoices.verifactu.rejectedMany", { count: s.rejected })}{" "}
          {t("invoices.verifactu.rejectedHelp")}
        </p>
      )}
      {s.zeroRateAssumed > 0 && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {t(s.zeroRateAssumed === 1 ? "invoices.verifactu.bannerZeroRateOne" : "invoices.verifactu.bannerZeroRateMany", {
            count: s.zeroRateAssumed,
          })}{" "}
          {t("invoices.verifactu.zeroRateHelp")}
        </p>
      )}

      <div className="space-y-3 border-t border-gray-100 pt-4">
        <h3 className="flex items-center gap-2 text-sm font-medium text-gray-900">
          <FileKey className="h-4 w-4 text-violet-600" /> {t("invoices.verifactu.certificate")}
        </h3>
        {s.certificate ? (
          <p className="flex items-start gap-2 text-sm text-gray-700">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
            <span>
              {s.certificate.subject ?? s.certificate.alias}
              {s.certificate.notAfter && (
                <span className="text-gray-500"> · {t("invoices.verifactu.expires", { date: new Date(s.certificate.notAfter).toLocaleDateString("es-ES") })}</span>
              )}
              {s.certificate.certificateType === "seal" && <span className="text-gray-500"> · {t("invoices.verifactu.seal")}</span>}
            </span>
          </p>
        ) : (
          <p className="text-sm text-gray-600">{t("invoices.verifactu.noCertificate")}</p>
        )}
        <p className="text-xs text-gray-500">
          {t("invoices.verifactu.certificateNote")}{" "}
          <a href="/legal/verifactu" target="_blank" rel="noopener noreferrer" className="text-violet-700 underline">
            {t("invoices.verifactu.declaration")}
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: "green" | "amber" | "red" | "gray" }) {
  const tones = {
    green: "bg-green-50 text-green-800",
    amber: "bg-amber-50 text-amber-800",
    red: "bg-red-50 text-red-800",
    gray: "bg-gray-50 text-gray-700",
  };
  return (
    <div className={`rounded-lg p-3 text-center ${tones[tone]}`}>
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}
