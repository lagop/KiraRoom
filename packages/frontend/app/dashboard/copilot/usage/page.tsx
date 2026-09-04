"use client";

/**
 * P2A-staff-copilot-sprint15: monthly usage stats for the copilot.
 *
 * Tenant admins / owners use this to monitor:
 *   - messages this month (broken down by role: user / assistant / tool / approval)
 *   - actions executed (write tools)
 *   - approval rate (what % of pending actions get approved vs expired)
 *   - cost-protection cap status
 *   - top 5 most active conversations
 *
 * Polls /assistant/usage on mount. No real-time updates — the user
 * can refresh manually. The data is used by SaaS admins via the
 * /saas debug panel too (RFC §11).
 */

import { useEffect, useState } from "react";
import apiClient, { AssistantUsage } from "@/lib/api";
import { Loader2, Activity, AlertTriangle, Check, X, Clock } from "lucide-react";

export default function CopilotUsagePage() {
  const [data, setData] = useState<AssistantUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const u = await apiClient.getAssistantUsage();
      setData(u);
    } catch (err) {
      setError((err as Error)?.message ?? "Error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Activity className="w-6 h-6 text-purple-600" />
            Uso del copiloto
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Estadísticas del mes en curso. Para el panel de plataforma, visita{" "}
            <a className="underline" href="/saas/debug">/saas/debug</a>.
          </p>
        </div>
        <button
          onClick={reload}
          className="px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Actualizar
        </button>
      </header>

      {loading && !data && (
        <div className="flex items-center gap-2 text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          Cargando…
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm">
          {error}
        </div>
      )}
      {data && (
        <>
          {data.overCostCap && (
            <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded-lg p-3 flex items-start gap-2 text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">Has superado el límite de coste mensual.</div>
                <div>El copiloto está en pausa hasta el día 1 del próximo mes.</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Mes" value={data.month} />
            <StatCard label="Mensajes usuario" value={data.messages?.user ?? 0} />
            <StatCard label="Respuestas IA" value={data.messages?.assistant ?? 0} />
            <StatCard label="Acciones ejecutadas" value={data.actionsTotal ?? 0} />
          </div>

          <section className="bg-white border border-gray-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              Aprobaciones de acciones
            </h2>
            <ApprovalRateBar breakdown={data.approvalBreakdown ?? {}} />
          </section>

          <section className="bg-white border border-gray-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">
              Conversaciones más activas
            </h2>
            {data.topConversations?.length ? (
              <ul className="divide-y divide-gray-100">
                {data.topConversations.map((c) => (
                  <li
                    key={c.conversationId}
                    className="py-2 flex items-center justify-between text-sm"
                  >
                    <code className="text-xs text-gray-600">{c.conversationId}</code>
                    <span className="text-gray-900 font-medium">{c.messages} mensajes</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">Sin actividad este mes.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900 mt-1">{value}</div>
    </div>
  );
}

function ApprovalRateBar({
  breakdown,
}: {
  breakdown: Record<string, number>;
}) {
  const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
  if (total === 0) {
    return <p className="text-sm text-gray-500">Sin acciones pendientes este mes.</p>;
  }
  const segments: Array<{ key: string; count: number; color: string; icon: any }> = [
    { key: 'executed', count: breakdown.executed ?? 0, color: 'bg-green-500', icon: Check },
    { key: 'approved', count: breakdown.approved ?? 0, color: 'bg-green-300', icon: Check },
    { key: 'rejected', count: breakdown.rejected ?? 0, color: 'bg-gray-400', icon: X },
    { key: 'expired',  count: breakdown.expired  ?? 0, color: 'bg-amber-400', icon: Clock },
  ];
  return (
    <div>
      <div className="flex w-full h-3 rounded-full overflow-hidden bg-gray-100">
        {segments.map((s) =>
          s.count > 0 ? (
            <div
              key={s.key}
              className={s.color}
              style={{ width: `${(s.count / total) * 100}%` }}
              title={`${s.key}: ${s.count}`}
            />
          ) : null,
        )}
      </div>
      <ul className="mt-3 space-y-1.5 text-xs text-gray-700">
        {segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${s.color}`} />
              <s.icon className="w-3 h-3" />
              <span className="capitalize">{s.key}</span>
              <span className="ml-auto font-medium">{s.count}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
