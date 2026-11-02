"use client";

import { useEffect, useState } from "react";
import {
  Link as LinkIcon,
  Unlink,
  AlertCircle,
  Check,
  ChevronDown,
} from "lucide-react";
import apiClient, { WhatsAppConnection } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useTranslations } from "@/lib/use-translation";

/** KiraRoom's standard templates (backend whatsapp-templates.ts), by name. */
const TEMPLATE_KEYS: Record<string, string> = {
  kiraroom_recordatorio_cita: "whatsappSettings.templateNames.reminder",
  kiraroom_cita_confirmada: "whatsappSettings.templateNames.confirmed",
  kiraroom_cita_cancelada: "whatsappSettings.templateNames.cancelled",
  kiraroom_cita_cambiada: "whatsappSettings.templateNames.changed",
  kiraroom_hueco_libre: "whatsappSettings.templateNames.freeSlot",
  kiraroom_opinion_cita: "whatsappSettings.templateNames.review",
};

const TEMPLATE_STATUS_KEYS: Record<string, string> = {
  APPROVED: "whatsappSettings.templateStatus.approved",
  REJECTED: "whatsappSettings.templateStatus.rejected",
  PENDING: "whatsappSettings.templateStatus.pending",
  NOT_SUBMITTED: "whatsappSettings.templateStatus.notSubmitted",
};

const QUALITY_KEYS: Record<string, string> = {
  GREEN: "whatsappSettings.quality.green",
  YELLOW: "whatsappSettings.quality.yellow",
  RED: "whatsappSettings.quality.red",
};

export default function WhatsAppSettingsPage() {
  const t = useTranslations();
  const { toast } = useToast();
  const [conn, setConn] = useState<WhatsAppConnection | null>(null);
  const [loading, setLoading] = useState(true);
  // A failed load is said as such: it used to show the connection forms to
  // a salon that is already connected.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [manual, setManual] = useState({
    accessToken: "",
    wabaId: "",
    phoneNumberId: "",
    displayPhone: "",
    displayName: "",
  });
  const [busy, setBusy] = useState(false);
  // Disconnecting is confirmed in the panel's dialog.
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [templates, setTemplates] = useState<Array<{ name: string; status: string }>>([]);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const c = await apiClient.getWhatsAppConnection();
      setConn(c);
      if (c) setTemplates(await apiClient.getWhatsAppStandardTemplates().catch(() => []));
    } catch (err: any) {
      setLoadError(err?.message || t("whatsappSettings.loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function submitTemplates() {
    setBusy(true);
    try {
      await apiClient.submitWhatsAppStandardTemplates();
      setTemplates(await apiClient.getWhatsAppStandardTemplates().catch(() => []));
      toast({ title: t("whatsappSettings.templatesSubmitted") });
    } catch (err: any) {
      toast({ title: t("whatsappSettings.templatesSubmitError"), description: err?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connectManual() {
    setBusy(true);
    try {
      await apiClient.manualWhatsAppConnect(manual);
      toast({ title: t("whatsappSettings.connected") });
      setManual({
        accessToken: "",
        wabaId: "",
        phoneNumberId: "",
        displayPhone: "",
        displayName: "",
      });
      await load();
    } catch (err: any) {
      toast({ title: t("whatsappSettings.connectError"), description: err?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function performDisconnect() {
    setDisconnecting(true);
    try {
      await apiClient.disconnectWhatsApp();
      toast({ title: t("whatsappSettings.disconnected") });
      await load();
    } catch (err: any) {
      toast({ title: t("whatsappSettings.disconnectError"), description: err?.message, variant: "destructive" });
    } finally {
      setDisconnecting(false);
      setConfirmDisconnect(false);
    }
  }

  if (loading) return <div className="text-gray-500">{t("common.loading")}</div>;

  if (loadError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-gray-900">{t("whatsappSettings.title")}</h1>
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p>{t("whatsappSettings.loadError")}</p>
            <p className="mt-1 text-xs">{loadError}</p>
            <button
              onClick={load}
              className="mt-2 rounded border border-red-300 px-3 py-1 text-xs hover:bg-red-100"
            >
              {t("whatsappSettings.retry")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t("whatsappSettings.title")}</h1>
        <p className="text-gray-500 mt-1">{t("whatsappSettings.subtitle")}</p>
      </div>

      {conn ? (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold flex items-center gap-2">
                <Check className="w-4 h-4 text-green-600" /> {t("whatsappSettings.connectedTitle")}
              </div>
              <div className="text-sm text-gray-500 mt-1">
                {conn.displayName || conn.displayPhone}
                {conn.displayName && conn.displayPhone ? ` · ${conn.displayPhone}` : ""}
              </div>
            </div>
            <span
              className={`text-xs px-2 py-1 rounded ${
                conn.qualityScore === "GREEN"
                  ? "bg-green-100 text-green-700"
                  : conn.qualityScore === "YELLOW"
                    ? "bg-yellow-100 text-yellow-700"
                    : conn.qualityScore === "RED"
                      ? "bg-red-100 text-red-700"
                      : "bg-gray-100 text-gray-600"
              }`}
            >
              {t("whatsappSettings.qualityLabel")}:{" "}
              {conn.qualityScore && QUALITY_KEYS[conn.qualityScore]
                ? t(QUALITY_KEYS[conn.qualityScore])
                : t("whatsappSettings.quality.unknown")}
            </span>
          </div>
          {conn.tokenExpiresAt && (
            <p className="text-sm text-gray-600">
              {t("whatsappSettings.accessExpires", {
                date: new Date(conn.tokenExpiresAt).toLocaleDateString("es-ES"),
              })}
            </p>
          )}

          <details className="group rounded-md border border-gray-100 px-3 py-2 text-sm">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-gray-600">
              <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
              {t("whatsappSettings.technicalData")}
            </summary>
            <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-gray-500">{t("whatsappSettings.fields.wabaId")}</dt>
                <dd className="break-all font-mono text-xs">{conn.wabaId || "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">{t("whatsappSettings.fields.phoneNumberId")}</dt>
                <dd className="break-all font-mono text-xs">{conn.phoneNumberId || "—"}</dd>
              </div>
            </dl>
          </details>

          <div className="border-t border-gray-100 pt-3">
            <div className="text-sm font-medium text-gray-900">{t("whatsappSettings.templatesTitle")}</div>
            <p className="text-xs text-gray-500 mt-1">{t("whatsappSettings.templatesIntro")}</p>
            <ul className="mt-2 space-y-1 text-sm">
              {templates.map((tpl) => (
                <li key={tpl.name} className="flex items-center justify-between gap-2">
                  <span className="text-xs">
                    {TEMPLATE_KEYS[tpl.name] ? t(TEMPLATE_KEYS[tpl.name]) : t("whatsappSettings.templateNames.other")}
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      tpl.status === "APPROVED"
                        ? "bg-green-100 text-green-700"
                        : tpl.status === "REJECTED"
                          ? "bg-red-100 text-red-700"
                          : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {TEMPLATE_STATUS_KEYS[tpl.status] ? t(TEMPLATE_STATUS_KEYS[tpl.status]) : tpl.status}
                  </span>
                </li>
              ))}
            </ul>
            {templates.some((tpl) => tpl.status !== "APPROVED" && tpl.status !== "PENDING") && (
              <button
                onClick={submitTemplates}
                disabled={busy}
                className="mt-2 text-xs px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
              >
                {t("whatsappSettings.submitTemplates")}
              </button>
            )}
          </div>
          <button
            onClick={() => setConfirmDisconnect(true)}
            className="text-red-600 hover:bg-red-50 px-3 py-1.5 rounded inline-flex items-center gap-2 text-sm"
          >
            <Unlink className="w-4 h-4" /> {t("whatsappSettings.disconnect")}
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* No "Conectar con Meta" (OAuth): it saved the token without the
              WhatsApp Business account or number, so it showed "Conectado"
              and sent nothing. Back once the embedded signup is built; the
              backend answers 410 meanwhile. */}
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="font-semibold mb-2">{t("whatsappSettings.manualTitle")}</h2>
            <p className="text-sm text-gray-500 mb-3">{t("whatsappSettings.manualIntro")}</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                label={t("whatsappSettings.fields.accessToken")}
                type="password"
                value={manual.accessToken}
                onChange={(v) => setManual({ ...manual, accessToken: v })}
              />
              <Input
                label={t("whatsappSettings.fields.wabaId")}
                value={manual.wabaId}
                onChange={(v) => setManual({ ...manual, wabaId: v })}
              />
              <Input
                label={t("whatsappSettings.fields.phoneNumberId")}
                value={manual.phoneNumberId}
                onChange={(v) => setManual({ ...manual, phoneNumberId: v })}
              />
              <Input
                label={t("whatsappSettings.fields.displayPhone")}
                placeholder="+34600000000"
                value={manual.displayPhone}
                onChange={(v) => setManual({ ...manual, displayPhone: v })}
              />
              <Input
                label={t("whatsappSettings.fields.displayName")}
                value={manual.displayName}
                onChange={(v) => setManual({ ...manual, displayName: v })}
              />
            </div>
            <div className="flex justify-end pt-3">
              <button
                onClick={connectManual}
                disabled={busy}
                className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                <LinkIcon className="w-4 h-4" />{" "}
                {busy ? t("whatsappSettings.connecting") : t("whatsappSettings.connect")}
              </button>
            </div>
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-700 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>{t("whatsappSettings.tokenStored")}</div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        title={t("whatsappSettings.disconnectConfirmTitle")}
        description={t("whatsappSettings.disconnectConfirmBody")}
        confirmLabel={t("whatsappSettings.disconnectCta")}
        cancelLabel={t("common.cancel")}
        destructive
        loading={disconnecting}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={performDisconnect}
      />
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
      />
    </div>
  );
}
