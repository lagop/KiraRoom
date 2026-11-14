"use client";

/**
 * P2A-staff-copilot-sprint15: monthly usage stats for the copilot.
 *
 * Owners and managers see:
 *   - questions today against the daily limit, and this month's messages
 *   - actions carried out (approved and done)
 *   - what became of the proposed actions
 *   - the cost cap status
 *   - who used it most (name, title, last use; never the content)
 *
 * Copilot audit B11: no more link to /saas/debug (it does not exist),
 * "Acciones ejecutadas" counted rejected and expired ones too, the
 * statuses were in English and the conversations were bare ids.
 */

import { useEffect, useState } from "react";
import apiClient, { AssistantUsage } from "@/lib/api";
import { Loader2, Activity, AlertTriangle, Check, X, Clock } from "lucide-react";
import { APPROVAL_STATUS_LABEL, type ApprovalStatus } from "@/lib/copilot-approval";

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function monthLabel(yyyyMm: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(yyyyMm);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : yyyyMm;
}

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
    } catch {
      setError("No se han podido cargar las estadísticas. Inténtalo de nuevo.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Activity className="w-6 h-6 text-purple-600" aria-hidden="true" />
            Uso del Copiloto
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {data ? `Datos de ${monthLabel(data.month)}.` : "Datos del mes en curso."}
          </p>
        </div>
        <button
          type="button"
          onClick={reload}
          className="px-3 py-1.5 text-sm bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Actualizar
        </button>
      </header>

      {loading && !data && (
        <div className="flex items-center gap-2 text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          Cargando…
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm" role="alert">
          {error}
        </div>
      )}
      {data && (
        <>
          {data.overCostCap && (
            <div className="bg-amber-50 border border-amber-300 text-amber-900 rounded-lg p-3 flex items-start gap-2 text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <div className="font-medium">Has llegado al límite de gasto mensual del Copiloto.</div>
                <div>Vuelve a funcionar el día 1 del próximo mes.</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Preguntas hoy"
              value={
                data.dailyQuestionCap != null
                  ? `${data.questionsToday ?? 0} de ${data.dailyQuestionCap}`
                  : data.questionsToday ?? 0
              }
            />
            <StatCard label="Preguntas este mes" value={data.messages?.user ?? 0} />
            <StatCard label="Respuestas este mes" value={data.messages?.assistant ?? 0} />
            <StatCard label="Acciones hechas" value={data.actionsTotal ?? 0} />
          </div>

          <section className="bg-white border border-gray-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Acciones propuestas este mes</h2>
            <ApprovalRateBar breakdown={data.approvalBreakdown ?? {}} />
          </section>

          <section className="bg-white border border-gray-200 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-3">Conversaciones con más mensajes</h2>
            {data.topConversations?.length ? (
              <ul className="divide-y divide-gray-100">
                {data.topConversations.map((c) => (
                  <li key={c.conversationId} className="py-2 flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0">
                      <div className="text-gray-900 truncate">{c.userName || "Persona del equipo"}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {[c.title, c.lastAt ? `último uso ${lastUse(c.lastAt)}` : null].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <span className="text-gray-900 font-medium shrink-0">{c.messages} mensajes</span>
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

function lastUse(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-semibold text-gray-900 mt-1">{value}</div>
    </div>
  );
}

function ApprovalRateBar({ breakdown }: { breakdown: Record<string, number> }) {
  const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
  if (total === 0) {
    return <p className="text-sm text-gray-500">El Copiloto no ha propuesto ninguna acción este mes.</p>;
  }
  const segments: Array<{ key: ApprovalStatus; count: number; color: string; icon: typeof Check }> = [
    { key: "executed", count: breakdown.executed ?? 0, color: "bg-green-500", icon: Check },
    { key: "approved", count: breakdown.approved ?? 0, color: "bg-green-300", icon: Check },
    { key: "rejected", count: breakdown.rejected ?? 0, color: "bg-gray-400", icon: X },
    { key: "expired", count: breakdown.expired ?? 0, color: "bg-amber-400", icon: Clock },
    { key: "pending", count: breakdown.pending ?? 0, color: "bg-amber-200", icon: Clock },
  ];
  return (
    <div>
      <div className="flex w-full h-3 rounded-full overflow-hidden bg-gray-100" aria-hidden="true">
        {segments.map((s) =>
          s.count > 0 ? (
            <div
              key={s.key}
              className={s.color}
              style={{ width: `${(s.count / total) * 100}%` }}
              title={`${APPROVAL_STATUS_LABEL[s.key]}: ${s.count}`}
            />
          ) : null,
        )}
      </div>
      <ul className="mt-3 space-y-1.5 text-xs text-gray-700">
        {segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className={`inline-block w-2.5 h-2.5 rounded-full ${s.color}`} aria-hidden="true" />
              <s.icon className="w-3 h-3" aria-hidden="true" />
              <span>{APPROVAL_STATUS_LABEL[s.key]}</span>
              <span className="ml-auto font-medium">{s.count}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
