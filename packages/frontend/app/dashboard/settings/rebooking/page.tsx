"use client";

import { useEffect, useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import apiClient, { RebookingConfig, RebookingTenantLog } from "@/lib/api";
import { Loader2, Save } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import { useToast } from "@/components/ui/use-toast";
import { formatSalonDateTime, rebookingChannelKey, rebookingStatusKey } from "@/lib/rebooking-log";

export default function RebookingSettingsPage() {
  const t = useTranslations();
  const qc = useQueryClient();
  const { toast } = useToast();
  const config = useQuery<RebookingConfig>({
    queryKey: ["rebooking", "config"],
    queryFn: () => apiClient.getRebookingConfig(),
  });
  // The salon's latest reminders, by name (GET /rebooking/log).
  const recent = useQuery<RebookingTenantLog>({
    queryKey: ["rebooking", "log", "tenant"],
    queryFn: () => apiClient.getRebookingTenantLog(20),
  });

  const save = useMutation({
    mutationFn: (patch: Partial<RebookingConfig>) =>
      apiClient.updateRebookingConfig(patch),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["rebooking", "config"] });
      toast({
        title: t("rebooking.settings.saved"),
        // A new lead time or minimum of visits reaches the clients the salon
        // already has: their next reminder date is recomputed now.
        description: res?.recomputing ? t("rebooking.settings.recomputing") : undefined,
      });
    },
    onError: (err: unknown) =>
      toast({
        title: t("rebooking.settings.saveError"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  const [draft, setDraft] = useState<Partial<RebookingConfig>>({});
  useEffect(() => {
    if (config.data) {
      const { recomputing: _ignored, ...stored } = config.data;
      void _ignored;
      // Email is the only channel; a stored "whatsapp" or "both" is email.
      setDraft({ ...stored, channelFallback: "email" });
    }
  }, [config.data]);

  if (config.isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  const timeZone = recent.data?.timezone ?? "Europe/Madrid";
  const items = recent.data?.items ?? [];

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
            {/* Email only: WhatsApp is not wired for these reminders, and a
                salon that picked it stopped getting any sent. Salons that had
                "WhatsApp" or "Email y WhatsApp" send by email (the backend
                reads them as email). */}
            <p className="mt-1 text-sm text-gray-900">{t("rebooking.settings.channelEmail")}</p>
            <p className="mt-1 text-xs text-gray-500">{t("rebooking.settings.channelEmailOnly")}</p>
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
            <p className="mt-1 text-xs text-gray-500">{t("rebooking.settings.recomputeHint")}</p>
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
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">
          {t("rebooking.settings.logTitle")}
        </h2>
        {recent.isLoading ? (
          <Loader2 className="mt-3 h-4 w-4 animate-spin text-gray-400" />
        ) : recent.isError ? (
          <p className="mt-3 text-sm text-red-600">{t("rebooking.settings.logError")}</p>
        ) : items.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th className="py-1 pr-2 font-medium">{t("rebooking.settings.logClient")}</th>
                  <th className="py-1 pr-2 font-medium">{t("rebooking.settings.logService")}</th>
                  <th className="py-1 pr-2 font-medium">{t("rebooking.settings.logDate")}</th>
                  <th className="py-1 pr-2 font-medium">{t("rebooking.settings.logChannel")}</th>
                  <th className="py-1 font-medium">{t("rebooking.settings.logStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="py-1.5 pr-2">{r.clientName ?? "—"}</td>
                    <td className="py-1.5 pr-2">{r.serviceName ?? "—"}</td>
                    <td className="whitespace-nowrap py-1.5 pr-2 text-xs text-gray-600">
                      {formatSalonDateTime(r.sentAt ?? r.scheduledAt, timeZone)}
                    </td>
                    <td className="py-1.5 pr-2 text-xs">{t(rebookingChannelKey(r.channel))}</td>
                    <td className="py-1.5 text-xs">{t(rebookingStatusKey(r.status))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-gray-500">{t("rebooking.settings.logEmpty")}</p>
        )}
      </div>
    </div>
  );
}
