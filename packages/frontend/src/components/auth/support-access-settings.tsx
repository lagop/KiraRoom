"use client";

import { useEffect, useState } from "react";
import { LifeBuoy } from "lucide-react";
import apiClient, { SupportAccessStatus } from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";
import { supportTab } from "@/lib/auth-storage";
import { supportSessionDuration } from "@/lib/support-session";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * "Permitir que soporte de KiraRoom entre en mi panel" and the salon's recent
 * support sessions (audit 8 D2). Owner only; a support session sees it but
 * the switch is off-limits to it (the server refuses too).
 */
export function SupportAccessSettings() {
  const t = useTranslations();
  const { toast } = useToast();
  const [isOwner, setIsOwner] = useState(false);
  const [inSupport, setInSupport] = useState(false);
  const [status, setStatus] = useState<SupportAccessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);

  // Read after mount: the token is in browser storage (render-time-user.spec).
  useEffect(() => {
    const owner = getCurrentUser()?.role === "owner";
    setIsOwner(owner);
    setInSupport(!!supportTab());
    if (!owner) return;
    apiClient
      .getSupportAccess()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (!isOwner || !status) return null;

  const save = async (allowed: boolean) => {
    setBusy(true);
    try {
      setStatus(await apiClient.updateSupportAccess(allowed));
      toast({ title: allowed ? t("supportAccess.saved_on") : t("supportAccess.saved_off") });
    } catch (err) {
      toast({
        title: t("supportAccess.save_failed"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
      setConfirmingOff(false);
    }
  };

  const toggle = () => {
    if (status.allowed) setConfirmingOff(true);
    else void save(true);
  };

  return (
    <section id="soporte" className="bg-white rounded-xl border border-gray-200 p-6 max-w-2xl space-y-4">
      <div className="flex items-start gap-3">
        <LifeBuoy className="w-6 h-6 text-gray-400 shrink-0" aria-hidden />
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t("supportAccess.title")}</h2>
          <p className="text-sm text-gray-600">{t("supportAccess.body")}</p>
        </div>
      </div>

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
          checked={status.allowed}
          onChange={toggle}
          disabled={busy || inSupport}
        />
        <span>
          <span className="block text-sm font-medium text-gray-900">{t("supportAccess.toggle")}</span>
          <span className="block text-sm text-gray-500">
            {inSupport ? t("supportAccess.support_mode") : status.allowed ? t("supportAccess.on") : t("supportAccess.off")}
          </span>
        </span>
      </label>

      <div>
        <h3 className="text-sm font-semibold text-gray-900 mb-2">{t("supportAccess.sessions_title")}</h3>
        {status.sessions.length === 0 ? (
          <p className="text-sm text-gray-500">{t("supportAccess.sessions_empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-4 font-medium">{t("supportAccess.col_date")}</th>
                  <th className="py-2 pr-4 font-medium">{t("supportAccess.col_reason")}</th>
                  <th className="py-2 pr-4 font-medium">{t("supportAccess.col_duration")}</th>
                  <th className="py-2 font-medium">{t("supportAccess.col_who")}</th>
                </tr>
              </thead>
              <tbody>
                {status.sessions.map((s) => (
                  <tr key={s.id} className="border-b border-gray-100 align-top">
                    <td className="py-2 pr-4 whitespace-nowrap text-gray-900">{when(s.startedAt)}</td>
                    <td className="py-2 pr-4 text-gray-700 break-words">{s.reason || t("supportAccess.no_reason")}</td>
                    <td className="py-2 pr-4 whitespace-nowrap text-gray-700">
                      {s.status === "active"
                        ? t("supportAccess.status_active")
                        : s.status === "expired"
                          ? t("supportAccess.status_expired")
                          : supportSessionDuration(s.durationSeconds, t)}
                    </td>
                    <td className="py-2 text-gray-700">{s.supportName || t("supportAccess.title")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmingOff}
        title={t("supportAccess.confirm_off_title")}
        description={t("supportAccess.confirm_off_body")}
        confirmLabel={t("supportAccess.confirm_off")}
        cancelLabel={t("common.cancel")}
        loading={busy}
        onCancel={() => setConfirmingOff(false)}
        onConfirm={() => void save(false)}
      />
    </section>
  );
}
