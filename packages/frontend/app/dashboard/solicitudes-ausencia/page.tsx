"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarOff, Check, Loader2, X } from "lucide-react";
import apiClient from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import {
  TIME_OFF_KIND_LABELS,
  TIME_OFF_REQUESTS_CHANGED,
  TIME_OFF_STATUS_LABELS,
  TIME_OFF_STATUS_STYLES,
  approvedToast,
  conflictLine,
  conflictTitle,
  dateRangeLabel,
  hoursLabel,
  statusOf,
  type TimeOff,
  type TimeOffConflict,
} from "@/lib/time-off";

/** How many clashes a dialog lists before "y N más". */
const LISTED_CONFLICTS = 8;
/** How many answered requests the page recalls. */
const RECENT_ANSWERS = 10;

const errorText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Inténtalo de nuevo.");

const who = (b: TimeOff) => b.professionalName?.trim() || "Profesional";

function ConflictList({ conflicts }: { conflicts: TimeOffConflict[] }) {
  return (
    <>
      <ul className="max-h-60 space-y-1 overflow-y-auto">
        {conflicts.slice(0, LISTED_CONFLICTS).map((c) => (
          <li key={c.id}>{conflictLine(c)}</li>
        ))}
      </ul>
      {conflicts.length > LISTED_CONFLICTS && <p>y {conflicts.length - LISTED_CONFLICTS} más.</p>}
    </>
  );
}

/**
 * The time off the professionals asked for, for the owner and managers to
 * approve or reject. Approving shows first the appointments that fall inside
 * it (they are not cancelled: the salon moves them or warns the client);
 * rejecting may carry a reason, which the professional reads.
 */
export default function TimeOffRequestsPage() {
  const { toast } = useToast();
  const [pending, setPending] = useState<TimeOff[]>([]);
  const [answered, setAnswered] = useState<TimeOff[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [approving, setApproving] = useState<{ request: TimeOff; conflicts: TimeOffConflict[] } | null>(null);
  const [rejecting, setRejecting] = useState<TimeOff | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // After an approval with clashes: what is left to move.
  const [toMove, setToMove] = useState<{ name: string; conflicts: TimeOffConflict[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const [open, approved, rejected] = await Promise.all([
        apiClient.getTimeOffRequests("pending"),
        apiClient.getTimeOffRequests("approved"),
        apiClient.getTimeOffRequests("rejected"),
      ]);
      setPending(open);
      setAnswered(
        [...approved, ...rejected]
          .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))
          .slice(0, RECENT_ANSWERS),
      );
      setLoadError(false);
    } catch (err) {
      console.error("Failed to load time off requests:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = async () => {
    window.dispatchEvent(new Event(TIME_OFF_REQUESTS_CHANGED));
    await load();
  };

  /** The clashes first, then the confirmation. */
  const askApprove = async (request: TimeOff) => {
    setBusy(request.id);
    try {
      const { conflicts } = await apiClient.previewTimeOff({
        professionalId: request.professionalId,
        kind: request.kind,
        startDate: request.startDate,
        endDate: request.endDate,
        startTime: request.startTime,
        endTime: request.endTime,
      });
      setApproving({ request, conflicts });
    } catch (err) {
      toast({ title: "No se han podido comprobar las citas", description: errorText(err), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (!approving) return;
    const { request } = approving;
    setBusy(request.id);
    try {
      const { conflicts } = await apiClient.approveTimeOff(request.id);
      toast(approvedToast(request.professionalName, conflicts.length));
      setToMove(conflicts.length ? { name: who(request), conflicts } : null);
      setApproving(null);
      await changed();
    } catch (err) {
      toast({ title: "No se ha aprobado", description: errorText(err), variant: "destructive" });
      setApproving(null);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (!rejecting) return;
    setBusy(rejecting.id);
    try {
      await apiClient.rejectTimeOff(rejecting.id, reason.trim() || null);
      toast({ title: "Solicitud rechazada", description: `Avisamos a ${who(rejecting)} en sus notificaciones.` });
      setRejecting(null);
      setReason("");
      await changed();
    } catch (err) {
      toast({ title: "No se ha rechazado", description: errorText(err), variant: "destructive" });
      setRejecting(null);
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Solicitudes de ausencia</h1>
        <p className="text-gray-500 mt-1">
          Lo que tu equipo ha pedido. Una solicitud no bloquea la agenda hasta que la apruebas; al aprobarla te
          mostramos las citas que coinciden, que no se cancelan: muévelas o avisa a los clientes.
        </p>
      </div>

      {toMove && (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="flex items-start justify-between gap-3">
            <p className="font-medium">
              {conflictTitle(toMove.conflicts.length, "ausencia")} de {toMove.name}: muévelas o avisa a los clientes.
            </p>
            <button
              type="button"
              onClick={() => setToMove(null)}
              aria-label="Cerrar"
              className="rounded p-1 text-amber-700 hover:bg-amber-100"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="mt-2 space-y-1">
            <ConflictList conflicts={toMove.conflicts} />
          </div>
          <Link href="/dashboard/appointments" className="mt-2 inline-block font-medium underline">
            Ir a la agenda
          </Link>
        </div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-6 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900">Pendientes</h2>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Cargando…
          </div>
        ) : loadError ? (
          <p role="alert" className="text-sm text-red-600">
            No se han podido cargar.{" "}
            <button type="button" onClick={() => void load()} className="font-medium underline">
              Reintentar
            </button>
          </p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-gray-500">No hay solicitudes pendientes.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200" data-test="time-off-requests">
            {pending.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 p-3">
                <CalendarOff className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900">
                    {who(r)} · {TIME_OFF_KIND_LABELS[r.kind]}
                    <span className="font-normal text-gray-600"> · {dateRangeLabel(r.startDate, r.endDate)}</span>
                  </p>
                  <p className="text-sm text-gray-500">
                    {hoursLabel(r)}
                    {r.note ? ` · ${r.note}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void askApprove(r)}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy === r.id && !rejecting ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Check className="h-4 w-4" aria-hidden="true" />
                    )}
                    Aprobar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReason("");
                      setRejecting(r);
                    }}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                    Rechazar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {answered.length > 0 && (
        <section className="rounded-xl border border-gray-200 bg-white p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Respondidas</h2>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {answered.map((r) => (
              <li key={r.id} className="flex items-start gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900">
                    {who(r)} · {TIME_OFF_KIND_LABELS[r.kind]}
                    <span className="font-normal text-gray-600"> · {dateRangeLabel(r.startDate, r.endDate)}</span>
                    <span
                      className={`ml-2 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${TIME_OFF_STATUS_STYLES[statusOf(r)]}`}
                    >
                      {TIME_OFF_STATUS_LABELS[statusOf(r)]}
                    </span>
                  </p>
                  <p className="text-sm text-gray-500">
                    {hoursLabel(r)}
                    {r.decisionNote ? ` · ${r.decisionNote}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-500">
            Una ausencia aprobada se cambia o se elimina desde la ficha del profesional.
          </p>
        </section>
      )}

      <ConfirmDialog
        open={!!approving}
        title={
          approving
            ? approving.conflicts.length
              ? conflictTitle(approving.conflicts.length, "ausencia")
              : `¿Aprobar la ausencia de ${who(approving.request)}?`
            : ""
        }
        description={
          approving && (
            <div className="space-y-2">
              <p>
                {TIME_OFF_KIND_LABELS[approving.request.kind]} ·{" "}
                {dateRangeLabel(approving.request.startDate, approving.request.endDate)} · {hoursLabel(approving.request)}
              </p>
              {approving.conflicts.length > 0 ? (
                <>
                  <ConflictList conflicts={approving.conflicts} />
                  <p>No se cancelan: apruébala y muévelas o avisa a los clientes, o vuelve atrás.</p>
                </>
              ) : (
                <p>No coincide con ninguna cita. Desde ahora no se ofrecerán citas en ese tiempo.</p>
              )}
            </div>
          )
        }
        confirmLabel={approving?.conflicts.length ? "Aprobar igualmente" : "Aprobar"}
        cancelLabel="Cancelar"
        loading={!!approving && busy === approving.request.id}
        onCancel={() => setApproving(null)}
        onConfirm={() => void approve()}
      />

      <ConfirmDialog
        open={!!rejecting}
        title={rejecting ? `¿Rechazar la ausencia de ${who(rejecting)}?` : ""}
        description={
          rejecting && (
            <div className="space-y-2">
              <p>
                {TIME_OFF_KIND_LABELS[rejecting.kind]} · {dateRangeLabel(rejecting.startDate, rejecting.endDate)} ·{" "}
                {hoursLabel(rejecting)}
              </p>
              <label className="block text-sm">
                <span className="mb-1 block text-gray-700">Motivo (opcional, lo verá en sus notificaciones)</span>
                <textarea
                  value={reason}
                  maxLength={200}
                  rows={2}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Temporada alta, ya hay otra persona fuera esos días…"
                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                />
              </label>
            </div>
          )
        }
        confirmLabel="Rechazar"
        destructive
        loading={!!rejecting && busy === rejecting.id}
        onCancel={() => setRejecting(null)}
        onConfirm={() => void reject()}
      />
    </div>
  );
}
