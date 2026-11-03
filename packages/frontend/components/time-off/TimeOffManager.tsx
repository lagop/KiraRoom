"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CalendarOff, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import apiClient from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { localDay } from "@/components/Calendar/day-grid";
import { useTranslations } from "@/lib/use-translation";
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
  isPastRequest,
  managerRowActions,
  myAbsences,
  requestBody,
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

/** Where the salon answers the requests. */
const REQUESTS_PAGE = "/dashboard/solicitudes-ausencia";

const errorText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Inténtalo de nuevo.");

/**
 * Current and upcoming time off of one professional, or the salon's closures,
 * with a form to add one, and an edit and a delete per row.
 *
 * In a professional's file the requests still waiting for an answer are
 * listed too, marked "Pendiente", with a link to answer them where the salon
 * answers requests (they are rejected, never deleted, so the professional
 * gets an answer).
 *
 * Saving never touches the appointments already booked: before saving, the
 * server lists the ones that fall inside the block, and the salon either
 * saves anyway (and moves them or warns the clients) or goes back.
 */
export function TimeOffManager({ professionalId, self = false }: TimeOffManagerProps) {
  const salon = !self && professionalId === null;
  const kinds = self ? REQUESTABLE_KINDS : PERSONAL_KINDS;
  const { toast } = useToast();
  const t = useTranslations();
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
  // The row being edited (managers): the form holds its values.
  const [editing, setEditing] = useState<TimeOff | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // The clashes the salon is asked about before saving anyway.
  const [pending, setPending] = useState<{ input: TimeOffInput; conflicts: TimeOffConflict[] } | null>(null);
  const [deleting, setDeleting] = useState<TimeOff | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      if (self) {
        setBlocks(myAbsences(await apiClient.getMyTimeOff(), today));
      } else {
        // The API answers up to 400 days at once: a year ahead is plenty. A
        // professional's file shows their requests still waiting too.
        const rows = await apiClient.getTimeOff(today, addDays(today, 399), professionalId ?? undefined, {
          includePending: !salon,
        });
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
    setEditing(null);
    setKind(salon ? "closure" : "vacation");
  };

  /** The form takes the row's values; saving changes it (PATCH) instead of adding one. */
  const startEdit = (b: TimeOff) => {
    setEditing(b);
    setKind(b.kind);
    setStartDate(b.startDate);
    setEndDate(b.endDate);
    setAllDay(!(b.startTime && b.endTime));
    setStartTime(b.startTime ?? "");
    setEndTime(b.endTime ?? "");
    setNote(b.note ?? "");
    setFormError(null);
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const clashesText = (count: number) =>
    count
      ? `Recuerda mover o avisar a ${count === 1 ? "la cita que coincide" : `las ${count} citas que coinciden`}.`
      : "Ya no se ofrecerán citas en ese tiempo.";

  const save = async (input: TimeOffInput) => {
    setSaving(true);
    try {
      if (self) {
        await apiClient.createTimeOffRequest(input);
        toast({
          title: "Solicitud enviada",
          description: "Te avisaremos en las notificaciones cuando el responsable la apruebe o la rechace.",
        });
      } else if (editing) {
        const { conflicts } = await apiClient.updateTimeOff(editing.id, requestBody(input));
        const told = editing.requested && editing.professionalName
          ? ` ${t("timeOff.requesterNotified", { name: editing.professionalName })}`
          : "";
        toast({
          title: salon ? t("timeOff.updatedClosure") : t("timeOff.updatedAbsence"),
          description: `${clashesText(conflicts.length)}${told}`,
        });
      } else {
        const { conflicts } = await apiClient.createTimeOff(input);
        toast({
          title: salon ? "Cierre guardado" : "Ausencia guardada",
          description: clashesText(conflicts.length),
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
    // The browser lets a typed date through (noValidate); the server refuses it too.
    if (self && isPastRequest(end, today)) {
      setFormError(t("timeOff.pastRequest"));
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
        : editing
          ? await apiClient.previewUpdateTimeOff(editing.id, requestBody(input))
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
      if (editing?.id === deleting.id) resetForm();
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
          {blocks.map((b) => {
            const dates = dateRangeLabel(b.startDate, b.endDate);
            const action = self ? null : managerRowActions(b);
            return (
              <li key={b.id} className={`flex items-start gap-3 p-3 ${editing?.id === b.id ? "bg-indigo-50" : ""}`}>
                <CalendarOff className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900">
                    {salon ? b.note?.trim() || "Salón cerrado" : TIME_OFF_KIND_LABELS[b.kind]}
                    <span className="font-normal text-gray-600"> · {dates}</span>
                    {(self || statusOf(b) === "pending") && (
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
                {self && canWithdraw(b) && (
                  <button
                    type="button"
                    onClick={() => setDeleting(b)}
                    aria-label={`Retirar la solicitud del ${dates}`}
                    title="Retirar la solicitud"
                    className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
                {action === "answer" && (
                  <Link
                    href={REQUESTS_PAGE}
                    title={t("timeOff.answerRequestTitle")}
                    className="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-50"
                  >
                    {t("timeOff.answerRequest")}
                  </Link>
                )}
                {action === "edit" && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(b)}
                      disabled={saving}
                      aria-label={t("timeOff.editAria", { what, dates })}
                      title={t("timeOff.edit")}
                      className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-indigo-600 disabled:opacity-50"
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleting(b)}
                      aria-label={`Eliminar ${what} del ${dates}`}
                      className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form
        ref={formRef}
        onSubmit={submit}
        className={`space-y-3 rounded-lg border p-4 ${editing ? "border-indigo-300 bg-indigo-50/40" : "border-dashed border-gray-300"}`}
        noValidate
      >
        <p className="text-sm font-medium text-gray-900">
          {editing
            ? salon
              ? t("timeOff.editTitleClosure")
              : t("timeOff.editTitleAbsence")
            : salon
              ? "Añadir un cierre"
              : self
                ? "Pedir una ausencia"
                : "Añadir una ausencia"}
        </p>
        {self && (
          <p className="text-xs text-gray-500">
            Quedará pendiente hasta que el responsable del salón la apruebe: mientras tanto tu agenda sigue abierta. Si
            estás de baja, avisa al responsable para que la registre.
          </p>
        )}
        {editing?.requested && editing.professionalName && (
          <p className="text-xs text-gray-500">{t("timeOff.editWillNotify", { name: editing.professionalName })}</p>
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
              // An absence already under way keeps its first day when edited.
              min={editing ? undefined : today}
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

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={saving || !startDate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : editing ? (
              <Pencil className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            {editing ? t("timeOff.saveChanges") : salon ? "Añadir cierre" : self ? "Enviar solicitud" : "Añadir ausencia"}
          </button>
          {editing && (
            <button
              type="button"
              onClick={resetForm}
              disabled={saving}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {t("timeOff.cancelEdit")}
            </button>
          )}
        </div>
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
              }${
                !self && deleting.requested && deleting.professionalName
                  ? ` ${t("timeOff.deleteWillNotify", { name: deleting.professionalName })}`
                  : ""
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
