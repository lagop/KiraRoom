"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarOff, Loader2, Plus, Trash2 } from "lucide-react";
import apiClient from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { localDay } from "@/components/Calendar/day-grid";
import {
  PERSONAL_KINDS,
  REQUESTABLE_KINDS,
  TIME_OFF_KIND_LABELS,
  TIME_OFF_STATUS_LABELS,
  TIME_OFF_STATUS_STYLES,
  canWithdraw,
  addDays,
  conflictLine,
  conflictTitle,
  dateRangeLabel,
  hoursLabel,
  isCurrentOrUpcoming,
  myAbsences,
  statusOf,
  timeOffFormProblem,
  type TimeOff,
  type TimeOffConflict,
  type TimeOffInput,
  type TimeOffKind,
} from "@/lib/time-off";

interface TimeOffManagerProps {
  /** A professional's absences; null for the salon's closures. Ignored with `self`. */
  professionalId: string | null;
  /**
   * The signed-in professional's own absences ("Mis ausencias"): what they add
   * is a request, pending until the salon approves it, and they may withdraw
   * it only while it is pending.
   */
  self?: boolean;
}

/** How many clashes the confirmation lists before "y N más". */
const LISTED_CONFLICTS = 8;

const errorText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Inténtalo de nuevo.");

/**
 * Current and upcoming time off of one professional, or the salon's closures,
 * with a form to add one and a delete per row.
 *
 * Saving never touches the appointments already booked: before saving, the
 * server lists the ones that fall inside the block, and the salon either
 * saves anyway (and moves them or warns the clients) or goes back.
 */
export function TimeOffManager({ professionalId, self = false }: TimeOffManagerProps) {
  const salon = !self && professionalId === null;
  const kinds = self ? REQUESTABLE_KINDS : PERSONAL_KINDS;
  const { toast } = useToast();
  const [today] = useState(() => localDay());
  const [blocks, setBlocks] = useState<TimeOff[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [kind, setKind] = useState<TimeOffKind>(salon ? "closure" : "vacation");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [allDay, setAllDay] = useState(true);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The clashes the salon is asked about before saving anyway.
  const [pending, setPending] = useState<{ input: TimeOffInput; conflicts: TimeOffConflict[] } | null>(null);
  const [deleting, setDeleting] = useState<TimeOff | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      if (self) {
        setBlocks(myAbsences(await apiClient.getMyTimeOff(), today));
      } else {
        // The API answers up to 400 days at once: a year ahead is plenty.
        const rows = await apiClient.getTimeOff(today, addDays(today, 399), professionalId ?? undefined);
        setBlocks(
          rows
            .filter((b) => (salon ? b.professionalId === null : b.professionalId === professionalId))
            .filter((b) => isCurrentOrUpcoming(b, today))
            .sort((a, b) => a.startDate.localeCompare(b.startDate) || (a.startTime ?? "").localeCompare(b.startTime ?? "")),
        );
      }
      setLoadError(false);
    } catch (err) {
      console.error("Failed to load time off:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [today, professionalId, salon, self]);

  useEffect(() => {
    void load();
  }, [load]);

  const singleDay = !!startDate && (!endDate || endDate === startDate);

  const resetForm = () => {
    setStartDate("");
    setEndDate("");
    setAllDay(true);
    setStartTime("");
    setEndTime("");
    setNote("");
    setFormError(null);
  };

  const save = async (input: TimeOffInput) => {
    setSaving(true);
    try {
      if (self) {
        await apiClient.createTimeOffRequest(input);
        toast({
          title: "Solicitud enviada",
          description: "Te avisaremos en las notificaciones cuando el responsable la apruebe o la rechace.",
        });
      } else {
        const { conflicts } = await apiClient.createTimeOff(input);
        toast({
          title: salon ? "Cierre guardado" : "Ausencia guardada",
          description: conflicts.length
            ? `Recuerda mover o avisar a ${conflicts.length === 1 ? "la cita que coincide" : `las ${conflicts.length} citas que coinciden`}.`
            : "Ya no se ofrecerán citas en ese tiempo.",
        });
      }
      setPending(null);
      resetForm();
      await load();
    } catch (err) {
      toast({ title: self ? "No se ha enviado" : "No se ha guardado", description: errorText(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const end = endDate || startDate;
    const problem = timeOffFormProblem({ startDate, endDate: end, allDay: allDay || !singleDay, startTime, endTime, note });
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    const input: TimeOffInput = {
      // A request carries no professional: the server takes the caller's own.
      ...(salon || self ? {} : { professionalId }),
      kind: salon ? "closure" : kind,
      startDate,
      endDate: end,
      startTime: allDay || !singleDay ? null : startTime,
      endTime: allDay || !singleDay ? null : endTime,
      note: note.trim() || null,
    };
    setSaving(true);
    try {
      const { conflicts } = self
        ? await apiClient.previewTimeOffRequest(input)
        : await apiClient.previewTimeOff(input);
      if (conflicts.length > 0) {
        setPending({ input, conflicts });
        setSaving(false);
        return;
      }
    } catch (err) {
      setSaving(false);
      setFormError(errorText(err));
      return;
    }
    await save(input);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      if (self) {
        await apiClient.cancelTimeOffRequest(deleting.id);
        toast({ title: "Solicitud retirada" });
      } else {
        await apiClient.deleteTimeOff(deleting.id);
        toast({ title: salon ? "Cierre eliminado" : "Ausencia eliminada" });
      }
      setDeleting(null);
      await load();
    } catch (err) {
      toast({ title: self ? "No se ha retirado" : "No se ha eliminado", description: errorText(err), variant: "destructive" });
    } finally {
      setDeletingBusy(false);
    }
  };

  const what = salon ? "cierre" : "ausencia";

  return (
    <div className="space-y-5">
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
      ) : blocks.length === 0 ? (
        <p className="text-sm text-gray-500">
          {salon ? "No hay cierres previstos." : self ? "No tienes ausencias previstas ni solicitudes." : "No tiene ausencias previstas."}
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200" data-test="time-off-list">
          {blocks.map((b) => (
            <li key={b.id} className="flex items-start gap-3 p-3">
              <CalendarOff className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900">
                  {salon ? b.note?.trim() || "Salón cerrado" : TIME_OFF_KIND_LABELS[b.kind]}
                  <span className="font-normal text-gray-600"> · {dateRangeLabel(b.startDate, b.endDate)}</span>
                  {self && (
                    <span
                      className={`ml-2 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${TIME_OFF_STATUS_STYLES[statusOf(b)]}`}
                      data-test="time-off-status"
                    >
                      {TIME_OFF_STATUS_LABELS[statusOf(b)]}
                    </span>
                  )}
                </p>
                <p className="text-sm text-gray-500">
                  {hoursLabel(b)}
                  {!salon && b.note ? ` · ${b.note}` : ""}
                </p>
                {self && b.decisionNote && (
                  <p className="text-sm text-gray-600">
                    {statusOf(b) === "rejected" ? "Motivo" : "Nota del responsable"}: {b.decisionNote}
                  </p>
                )}
              </div>
              {(!self || canWithdraw(b)) && (
                <button
                  type="button"
                  onClick={() => setDeleting(b)}
                  aria-label={
                    self
                      ? `Retirar la solicitud del ${dateRangeLabel(b.startDate, b.endDate)}`
                      : `Eliminar ${what} del ${dateRangeLabel(b.startDate, b.endDate)}`
                  }
                  title={self ? "Retirar la solicitud" : undefined}
                  className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="space-y-3 rounded-lg border border-dashed border-gray-300 p-4" noValidate>
        <p className="text-sm font-medium text-gray-900">
          {salon ? "Añadir un cierre" : self ? "Pedir una ausencia" : "Añadir una ausencia"}
        </p>
        {self && (
          <p className="text-xs text-gray-500">
            Quedará pendiente hasta que el responsable del salón la apruebe: mientras tanto tu agenda sigue abierta. Si
            estás de baja, avisa al responsable para que la registre.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          {!salon && (
            <label className="block text-sm">
              <span className="mb-1 block text-gray-700">Tipo</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as TimeOffKind)}
                disabled={saving}
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
              >
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {TIME_OFF_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm">
            <span className="mb-1 block text-gray-700">Desde</span>
            <input
              type="date"
              value={startDate}
              min={today}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (!endDate || endDate < e.target.value) setEndDate(e.target.value);
              }}
              disabled={saving}
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-gray-700">Hasta (incluido)</span>
            <input
              type="date"
              value={endDate}
              min={startDate || today}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={saving}
              className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={allDay || !singleDay}
              onChange={(e) => setAllDay(e.target.checked)}
              disabled={saving || !singleDay}
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
            />
            Todo el día
          </label>
          {!allDay && singleDay && (
            <div className="flex items-center gap-2">
              <input
                type="time"
                aria-label="Hora de inicio"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                disabled={saving}
                className="rounded-md border border-gray-300 px-2 py-1 text-sm"
              />
              <span className="text-gray-400">–</span>
              <input
                type="time"
                aria-label="Hora de fin"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                disabled={saving}
                className="rounded-md border border-gray-300 px-2 py-1 text-sm"
              />
            </div>
          )}
          {!singleDay && startDate && (
            <span className="text-xs text-gray-500">Las horas solo se pueden indicar para un único día.</span>
          )}
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-gray-700">
            {salon
              ? "Motivo (se muestra en la agenda, no a los clientes)"
              : self
                ? "Nota para el responsable (opcional, no la ven tus compañeros)"
                : "Nota (solo la ven los responsables)"}
          </span>
          <input
            type="text"
            value={note}
            maxLength={200}
            placeholder={salon ? "Navidad, fiesta local, reforma…" : "Opcional"}
            onChange={(e) => setNote(e.target.value)}
            disabled={saving}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>

        {formError && (
          <p role="alert" className="text-sm text-red-600">
            {formError}
          </p>
        )}

        <button
          type="submit"
          disabled={saving || !startDate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
          {salon ? "Añadir cierre" : self ? "Enviar solicitud" : "Añadir ausencia"}
        </button>
      </form>

      <ConfirmDialog
        open={!!pending}
        title={pending ? conflictTitle(pending.conflicts.length, what) : ""}
        description={
          pending && (
            <div className="space-y-2">
              <ul className="max-h-60 space-y-1 overflow-y-auto">
                {pending.conflicts.slice(0, LISTED_CONFLICTS).map((c) => (
                  <li key={c.id}>{conflictLine(c)}</li>
                ))}
              </ul>
              {pending.conflicts.length > LISTED_CONFLICTS && (
                <p>y {pending.conflicts.length - LISTED_CONFLICTS} más.</p>
              )}
              <p>
                {self
                  ? "No se cancelan: si el responsable aprueba la ausencia, se encargará de moverlas o avisar a los clientes."
                  : "No se cancelan: guárdalo igualmente y muévelas o avisa a los clientes, o vuelve atrás."}
              </p>
            </div>
          )
        }
        confirmLabel={self ? "Enviar igualmente" : "Guardar igualmente"}
        cancelLabel="Cancelar"
        loading={saving}
        onCancel={() => setPending(null)}
        onConfirm={() => pending && void save(pending.input)}
      />

      <ConfirmDialog
        open={!!deleting}
        title={salon ? "¿Eliminar este cierre?" : self ? "¿Retirar esta solicitud?" : "¿Eliminar esta ausencia?"}
        description={
          deleting
            ? `${dateRangeLabel(deleting.startDate, deleting.endDate)} · ${hoursLabel(deleting)}.${
                self ? " El responsable ya no la verá." : " Se volverán a ofrecer citas en ese tiempo."
              }`
            : undefined
        }
        confirmLabel={self ? "Retirar" : "Eliminar"}
        destructive
        loading={deletingBusy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
