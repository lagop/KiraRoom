"use client";

import { use } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import apiClient, {
  ClientCadence,
  RebookingReminder,
} from "@/lib/api";
import { Loader2, RefreshCcw, BellOff, BellRing } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";

export default function ClientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = useTranslations();
  const { id } = use(params);
  const qc = useQueryClient();

  const cadence = useQuery<ClientCadence | null>({
    queryKey: ["rebooking", "prediction", id],
    queryFn: () => apiClient.getRebookingPrediction(id),
    enabled: !!id,
  });
  const log = useQuery<RebookingReminder[]>({
    queryKey: ["rebooking", "log", id],
    queryFn: () => apiClient.getRebookingLog(id),
    enabled: !!id,
  });

  const recompute = useMutation({
    mutationFn: () => apiClient.recomputeClientCadence(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rebooking", "prediction", id] });
    },
  });
  const optOut = useMutation({
    mutationFn: () => apiClient.optOutClientRebooking(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rebooking", "prediction", id] });
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
         <h1 className="text-2xl font-bold text-gray-900 truncate">Cliente {id}</h1>
        <a
          href="/dashboard/clients"
          className="text-sm text-violet-600 hover:underline"
        >
          ← Volver
        </a>
      </header>

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              {t("rebooking.client.predictionTitle")}
            </h2>
            {cadence.isLoading && (
              <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {cadence.data?.optedOut && (
              <p className="mt-2 text-sm text-amber-700">
                {t("rebooking.client.optedOut")}
              </p>
            )}
            {cadence.data && !cadence.data.optedOut && (
              <RebookingSummary cadence={cadence.data} />
            )}
            {cadence.data &&
              !cadence.data.optedOut &&
              Object.keys(cadence.data.byService).length === 0 && (
                <p className="mt-2 text-sm text-gray-500">
                  {t("rebooking.client.noData", { minVisits: 3 })}
                </p>
              )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={recompute.isPending}
              onClick={() => recompute.mutate()}
              className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              {recompute.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCcw className="h-3 w-3" />
              )}
              {t("rebooking.client.recompute")}
            </button>
            {cadence.data && !cadence.data.optedOut && (
              <button
                type="button"
                disabled={optOut.isPending}
                onClick={() => optOut.mutate()}
                className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <BellOff className="h-3 w-3" />
                {t("rebooking.client.disable")}
              </button>
            )}
          </div>
        </div>

        {cadence.data && Object.keys(cadence.data.byService).length > 0 && (
          <div className="overflow-x-auto">
            <table className="mt-6 w-full min-w-[640px] text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="whitespace-nowrap text-left">Servicio</th>
                 <th className="whitespace-nowrap text-left">{t("rebooking.client.nextExpected")}</th>
                 <th className="whitespace-nowrap text-left">{t("rebooking.client.interval")}</th>
                 <th className="whitespace-nowrap text-left">{t("rebooking.client.lastReminder")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(cadence.data.byService).map(([svcId, s]) => {
                const reminder = cadence.data?.reminderSentFor.find(
                  (r) => r.serviceId === svcId,
                );
                return (
                  <tr key={svcId} className="border-t border-gray-100">
                    <td>{svcId}</td>
                    <td>
                      {new Date(s.nextExpectedAt).toLocaleDateString("es-ES")}
                    </td>
                    <td>
                      {s.avgDays}d ± {s.stdDevDays}d
                    </td>
                    <td>
                      {reminder
                        ? new Date(reminder.sentAt).toLocaleDateString("es-ES")
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">
          Historial de recordatorios
        </h2>
        {log.data && log.data.length > 0 ? (
          <ul className="mt-3 divide-y divide-gray-100">
            {log.data.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span>{r.serviceId ?? "—"}</span>
                <span className="text-xs text-gray-500">{r.status}</span>
                <span className="text-xs text-gray-400">
                  {r.sentAt
                    ? new Date(r.sentAt).toLocaleString("es-ES")
                    : new Date(r.scheduledAt).toLocaleString("es-ES")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-gray-500">—</p>
        )}
      </section>
    </div>
  );
}

function RebookingSummary({ cadence }: { cadence: ClientCadence }) {
  const t = useTranslations();
  const nextAt = cadence.nextRecommendedReminderAt;
  return (
    <div className="mt-2 text-sm text-gray-700">
      {nextAt ? (
        <p>
          {t("rebooking.client.nextExpected")}:{" "}
          <strong>{new Date(nextAt).toLocaleDateString("es-ES")}</strong>
        </p>
      ) : (
        <p>—</p>
      )}
    </div>
  );
}