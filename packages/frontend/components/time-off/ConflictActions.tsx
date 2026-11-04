"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import {
  TIME_OFF_CANCEL_REASON,
  agendaLink,
  conflictLine,
  freeForAll,
  type FreeProfessionals,
  type TimeOffConflict,
} from "@/lib/time-off";

const errorText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Inténtalo de nuevo.");

/** What became of an appointment here. */
type Outcome = { ok: true; text: string } | { ok: false; text: string };

/** The open form: passing (one or the selection) or cancelling (one or the selection). */
type Open =
  | { kind: "pass"; ids: string[]; loading: boolean; free: Array<{ id: string; name: string }>; note?: string; pick: string }
  | { kind: "cancel"; ids: string[]; reason: string };

/**
 * The appointments time off or a closure caught, each with what the salon
 * can do about it, one by one or for those it ticks: pass it to a colleague
 * who does the service and is free then (the move is checked again by the
 * server), or cancel it and tell the client -- by the channels she accepted,
 * with a link to book again; the slot is not offered to the wait list.
 * Nothing happens without a click.
 */
export function ConflictActions({
  conflicts,
  limit,
  onChanged,
  extra,
}: {
  conflicts: TimeOffConflict[];
  /** How many to list before "y N más". */
  limit: number;
  /** After something changed (the caller reloads what it shows). */
  onChanged?: () => void;
  /** Shown after each line (why it is caught). */
  extra?: (c: TimeOffConflict) => React.ReactNode;
}) {
  const t = useTranslations();
  const [selected, setSelected] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [open, setOpen] = useState<Open | null>(null);
  const [busy, setBusy] = useState(false);

  const listed = conflicts.slice(0, limit);
  const actionable = listed.filter((c) => !outcomes[c.id]?.ok);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const allTicked = actionable.length > 0 && actionable.every((c) => selected.includes(c.id));

  const openPass = async (ids: string[]) => {
    setOpen({ kind: "pass", ids, loading: true, free: [], pick: "" });
    try {
      const lists: FreeProfessionals[] = await Promise.all(ids.map((id) => apiClient.getFreeProfessionalsForAppointment(id)));
      const free = freeForAll(lists);
      const note =
        ids.length === 1 && !lists[0].reassignable
          ? lists[0].reason
          : free.length === 0
            ? ids.length === 1
              ? t("timeOff.actions.noneFree")
              : t("timeOff.actions.noneFreeAll")
            : undefined;
      setOpen({ kind: "pass", ids, loading: false, free, note, pick: free[0]?.id ?? "" });
    } catch (err) {
      setOpen({ kind: "pass", ids, loading: false, free: [], note: errorText(err), pick: "" });
    }
  };

  /** Runs `act` on each id in turn; each one's outcome shows on its line. */
  const run = async (ids: string[], act: (id: string) => Promise<string>) => {
    setBusy(true);
    const next: Record<string, Outcome> = {};
    for (const id of ids) {
      try {
        next[id] = { ok: true, text: await act(id) };
      } catch (err) {
        next[id] = { ok: false, text: t("timeOff.actions.failed", { error: errorText(err) }) };
      }
    }
    setOutcomes((o) => ({ ...o, ...next }));
    setSelected((s) => s.filter((id) => !next[id]?.ok));
    setOpen(null);
    setBusy(false);
    if (Object.values(next).some((o) => o.ok)) onChanged?.();
  };

  const pass = () => {
    if (open?.kind !== "pass" || !open.pick) return;
    const to = open.free.find((p) => p.id === open.pick);
    void run(open.ids, async (id) => {
      await apiClient.updateAppointment(id, { professionalId: open.pick });
      return t("timeOff.actions.passed", { name: to?.name ?? "" });
    });
  };

  const cancel = () => {
    if (open?.kind !== "cancel") return;
    const reason = open.reason.trim() || null;
    void run(open.ids, async (id) => {
      await apiClient.cancelAppointmentForTimeOff(id, reason);
      return t("timeOff.actions.cancelled");
    });
  };

  const form = (ids: string[]) =>
    open && open.ids.join() === ids.join() ? (
      <div className="mt-2 space-y-2 rounded-md border border-gray-200 bg-white p-3 text-gray-800" data-test="conflict-action-form">
        {open.kind === "pass" ? (
          open.loading ? (
            <p className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t("timeOff.actions.loadingFree")}
            </p>
          ) : open.free.length === 0 ? (
            <>
              <p className="text-sm">{open.note}</p>
              <button type="button" onClick={() => setOpen(null)} className="text-sm font-medium underline">
                {t("timeOff.actions.back")}
              </button>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-sm">
                <span className="sr-only">{t("timeOff.actions.choose")}</span>
                <select
                  value={open.pick}
                  onChange={(e) => setOpen({ ...open, pick: e.target.value })}
                  disabled={busy}
                  className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                >
                  {open.free.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={pass}
                disabled={busy || !open.pick}
                className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {ids.length === 1 ? t("timeOff.actions.confirmPass") : t("timeOff.actions.confirmPassMany", { count: ids.length })}
              </button>
              <button type="button" onClick={() => setOpen(null)} disabled={busy} className="text-sm underline">
                {t("timeOff.actions.back")}
              </button>
            </div>
          )
        ) : (
          <>
            <label className="block text-sm">
              <span className="mb-1 block text-gray-700">{t("timeOff.actions.reasonLabel")}</span>
              <textarea
                value={open.reason}
                maxLength={500}
                rows={2}
                onChange={(e) => setOpen({ ...open, reason: e.target.value })}
                disabled={busy}
                className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
            <p className="text-xs text-gray-500">{t("timeOff.actions.channels")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={cancel}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {ids.length === 1 ? t("timeOff.actions.confirmCancel") : t("timeOff.actions.confirmCancelMany", { count: ids.length })}
              </button>
              <button type="button" onClick={() => setOpen(null)} disabled={busy} className="text-sm underline">
                {t("timeOff.actions.back")}
              </button>
            </div>
          </>
        )}
      </div>
    ) : null;

  const actionButtons = (ids: string[]) => (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      <button
        type="button"
        onClick={() => void openPass(ids)}
        disabled={busy}
        className="font-medium underline decoration-dotted underline-offset-2 disabled:opacity-50"
      >
        {ids.length === 1 ? t("timeOff.actions.pass") : t("timeOff.actions.passSelected", { count: ids.length })}
      </button>
      <button
        type="button"
        onClick={() => setOpen({ kind: "cancel", ids, reason: TIME_OFF_CANCEL_REASON })}
        disabled={busy}
        className="font-medium text-red-700 underline decoration-dotted underline-offset-2 disabled:opacity-50"
      >
        {ids.length === 1 ? t("timeOff.actions.cancel") : t("timeOff.actions.cancelSelected", { count: ids.length })}
      </button>
    </span>
  );

  return (
    <div className="space-y-2" data-test="conflict-actions">
      {actionable.length > 1 && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={allTicked}
              onChange={() => setSelected(allTicked ? [] : actionable.map((c) => c.id))}
              disabled={busy}
              className="h-4 w-4 rounded border-gray-300"
            />
            {t("timeOff.actions.selectAll")}
          </label>
          {selected.length > 0 && actionButtons(selected)}
        </div>
      )}
      {selected.length > 1 && form(selected)}
      <ul className="max-h-80 space-y-2 overflow-y-auto">
        {listed.map((c) => {
          const outcome = outcomes[c.id];
          const done = outcome?.ok;
          return (
            <li key={c.id}>
              <div className="flex items-start gap-2">
                {actionable.length > 1 && !done && (
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    onChange={() => toggle(c.id)}
                    disabled={busy}
                    aria-label={t("timeOff.actions.select", { line: conflictLine(c) })}
                    className="mt-1 h-4 w-4 rounded border-gray-300"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <Link
                    href={agendaLink(c.date, c.id)}
                    className={`underline decoration-amber-400 underline-offset-2 hover:decoration-amber-700 ${done ? "line-through opacity-60" : ""}`}
                  >
                    {conflictLine(c)}
                  </Link>
                  {extra?.(c)}
                  {outcome && (
                    <span className={outcome.ok ? "text-green-700" : "text-red-700"} role="status">
                      {" "}
                      · {outcome.text}
                    </span>
                  )}
                  {!done && <div className="text-xs">{actionButtons([c.id])}</div>}
                  {form([c.id])}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {conflicts.length > limit && <p>{t("timeOff.upcoming.more", { count: conflicts.length - limit })}</p>}
    </div>
  );
}
