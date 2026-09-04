"use client";

import { useEffect, useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import apiClient, { RebookingConfig, RebookingReminder } from "@/lib/api";
import { Loader2, Save } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";

export default function RebookingSettingsPage() {
  const t = useTranslations();
  const qc = useQueryClient();
  const config = useQuery<RebookingConfig>({
    queryKey: ["rebooking", "config"],
    queryFn: () => apiClient.getRebookingConfig(),
  });
  const recent = useQuery<RebookingReminder[]>({
    queryKey: ["rebooking", "log", "tenant"],
    queryFn: async () => {
      return [];
    },
  });

  const save = useMutation({
    mutationFn: (patch: Partial<RebookingConfig>) =>
      apiClient.updateRebookingConfig(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rebooking", "config"] }),
  });

  const [draft, setDraft] = useState<Partial<RebookingConfig>>({});
  useEffect(() => {
    if (config.data) setDraft(config.data);
  }, [config.data]);

  if (config.isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">
          {t("rebooking.settings.title")}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {t("rebooking.settings.subtitle")}
        </p>
      </header>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="space-y-5">
          <label className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-900">
              {t("rebooking.settings.enabled")}
            </span>
            <input
              type="checkbox"
              checked={draft.enabled ?? false}
              onChange={(e) =>
                setDraft((d) => ({ ...d, enabled: e.target.checked }))
              }
              className="h-5 w-5 rounded border-gray-300 text-violet-600"
            />
          </label>

          <div>
            <label className="text-sm font-medium text-gray-900">
              {t("rebooking.settings.leadDays")}
            </label>
            <input
              type="number"
              min={1}
              max={7}
              value={draft.leadDays ?? 3}
              onChange={(e) =>
                setDraft((d) => ({ ...d, leadDays: Number(e.target.value) }))
              }
              className="mt-1 block w-32 rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-gray-900">
              {t("rebooking.settings.channelFallback")}
            </label>
            <select
              value={draft.channelFallback ?? "both"}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  channelFallback: e.target.value as RebookingConfig["channelFallback"],
                }))
              }
              className="mt-1 block w-64 rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="email">{t("rebooking.settings.channelEmail")}</option>
              <option value="whatsapp">{t("rebooking.settings.channelWhatsapp")}</option>
              <option value="both">{t("rebooking.settings.channelBoth")}</option>
            </select>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-900">
              {t("rebooking.settings.minVisits")}
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={draft.minVisits ?? 3}
              onChange={(e) =>
                setDraft((d) => ({ ...d, minVisits: Number(e.target.value) }))
              }
              className="mt-1 block w-32 rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
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
            {t("rebooking.settings.save")}
          </button>
        </div>
        {save.isSuccess && (
          <p className="mt-2 text-right text-xs text-green-600">
            {t("rebooking.settings.saved")}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">
          {t("rebooking.settings.logTitle")}
        </h2>
        {recent.data && recent.data.length > 0 ? (
          <table className="mt-3 w-full text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="text-left">Cliente</th>
                <th className="text-left">Servicio</th>
                <th className="text-left">Estado</th>
                <th className="text-left">Enviado</th>
              </tr>
            </thead>
            <tbody>
              {recent.data.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td>{r.clientId}</td>
                  <td>{r.serviceId ?? "—"}</td>
                  <td>{r.status}</td>
                  <td>{r.sentAt ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 text-sm text-gray-500">—</p>
        )}
      </div>
    </div>
  );
}