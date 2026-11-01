"use client";

import { useCallback, useEffect, useState } from "react";
import apiClient, {
  type CashMovementType,
  type CashSessionCurrent,
  type CashSessionList,
  type CashSessionView,
} from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { methodLabel } from "@/lib/payments-format";
import { euros, parseEurosInput } from "@/lib/pos-cart";
import {
  DENOMINATIONS,
  breakdownForServer,
  countTotalCents,
  denominationLabel,
  discrepancy,
  discrepancyClass,
  movementProblem,
  type CountRows,
} from "@/lib/cash-session";
import CashSessionReport, { salonDateTime, useDiscrepancyText } from "./cash-session-report";

interface CashDrawerProps {
  /** Bumped after each sale or refund: the expected cash is read again. */
  refreshKey: number;
  /** Whether the drawer is open (null while loading): the till refuses cash when it is not. */
  onStateChange?: (open: boolean | null) => void;
}

/**
 * The cash drawer at the till (apertura y cierre de caja, arqueo):
 *
 * - closed: "Caja cerrada — Abrir caja" with the float (the last count
 *   offered);
 * - open: who opened it, the float and the cash it should hold now, with
 *   "Movimiento de caja" (money in or out, with why) and "Cerrar caja";
 * - closing: what was taken by method, the cash in the drawer, the count
 *   (optionally coin by coin), the difference in colour, confirmed in a
 *   ConfirmDialog, then the printable closing report;
 * - "Historial de cajas" for the owner and managers.
 */
export default function CashDrawer({ refreshKey, onStateChange }: CashDrawerProps) {
  const t = useTranslations();
  const { toast } = useToast();
  const diffText = useDiscrepancyText();
  const [state, setState] = useState<CashSessionCurrent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Opening
  const [floatText, setFloatText] = useState("");

  // Money in or out
  const [movementOpen, setMovementOpen] = useState(false);
  const [movementType, setMovementType] = useState<CashMovementType>("out");
  const [movementAmount, setMovementAmount] = useState("");
  const [movementReason, setMovementReason] = useState("");

  // Closing
  const [closing, setClosing] = useState(false);
  const [countedText, setCountedText] = useState("");
  const [showCount, setShowCount] = useState(false);
  const [countRows, setCountRows] = useState<CountRows>({});
  const [closeNotes, setCloseNotes] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);

  // Reports and history
  const [report, setReport] = useState<CashSessionView | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const current = await apiClient.getCurrentCashSession();
      setState(current);
      setLoadError(null);
      onStateChange?.(!!current.session);
      if (!current.session && current.lastClosed?.countedCashCents != null) {
        setFloatText((text) => text || (current.lastClosed!.countedCashCents! / 100).toFixed(2).replace(".", ","));
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t("pos.cash_session.load_failed"));
      onStateChange?.(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const session = state?.session ?? null;
  const expected = session?.expectedCashCents ?? 0;

  const openDrawer = async () => {
    const cents = parseEurosInput(floatText || "0");
    if (cents === null) {
      toast({ title: t("pos.cash_session.open_failed"), description: t("pos.cash_session.err_float"), variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await apiClient.openCashSession({ openingFloatCents: cents });
      toast({ title: t("pos.cash_session.opened_toast"), description: t("pos.cash_session.opened_toast_desc", { amount: euros(cents) }) });
      setFloatText("");
      await load();
    } catch (e: any) {
      toast({ title: t("pos.cash_session.open_failed"), description: e?.message, variant: "destructive" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const movementCents = parseEurosInput(movementAmount);
  const movementIssue = movementProblem(movementCents, movementReason, movementType, expected);
  const saveMovement = async () => {
    if (!session || movementIssue) return;
    setBusy(true);
    try {
      await apiClient.addCashMovement(session.id, { type: movementType, amountCents: movementCents!, reason: movementReason.trim() });
      toast({
        title: t("pos.cash_session.movement_saved"),
        description: `${movementType === "in" ? "+" : "−"}${euros(movementCents!)} · ${movementReason.trim()}`,
      });
      setMovementOpen(false);
      setMovementAmount("");
      setMovementReason("");
      await load();
    } catch (e: any) {
      toast({ title: t("pos.cash_session.movement_failed"), description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const startClose = async () => {
    // The figures as they are now, not as they were when the page loaded.
    await load();
    setCountedText("");
    setCountRows({});
    setShowCount(false);
    setCloseNotes("");
    setClosing(true);
  };
  const countTotal = countTotalCents(countRows);
  const countedCents = showCount ? countTotal : parseEurosInput(countedText);
  const diff = countedCents === null ? null : discrepancy(countedCents, expected);

  const closeDrawer = async () => {
    if (!session || countedCents === null) return;
    setBusy(true);
    try {
      const closed = await apiClient.closeCashSession(session.id, {
        countedCashCents: countedCents,
        ...(showCount ? { breakdown: breakdownForServer(countRows) } : {}),
        ...(closeNotes.trim() ? { notes: closeNotes.trim() } : {}),
      });
      setConfirmClose(false);
      setClosing(false);
      toast({
        title: t("pos.cash_session.closed_toast"),
        description: `${t("pos.cash_session.difference")}: ${diffText(closed.discrepancyCents ?? 0)}`,
      });
      setReport(closed);
      await load();
    } catch (e: any) {
      setConfirmClose(false);
      toast({ title: t("pos.cash_session.close_failed"), description: e?.message, variant: "destructive" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loadError && !state) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        {t("pos.cash_session.load_failed")}: {loadError}
      </div>
    );
  }
  if (!state) return null;

  return (
    <>
      {!session ? (
        <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <div className="font-semibold text-amber-900">{t("pos.cash_session.closed_title")}</div>
            <p className="text-sm text-amber-900/80">{t("pos.cash_session.closed_hint")}</p>
            {state.lastClosed?.countedCashCents != null && (
              <p className="mt-1 text-xs text-amber-900/70">
                {t("pos.cash_session.float_hint_last", { amount: euros(state.lastClosed.countedCashCents) })}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm text-amber-900">
              <span className="mb-1 block">{t("pos.cash_session.float_label")}</span>
              <input
                type="text"
                inputMode="decimal"
                value={floatText}
                onChange={(e) => setFloatText(e.target.value)}
                placeholder="0,00"
                className="w-28 rounded-lg border px-3 py-2"
              />
            </label>
            <button
              type="button"
              onClick={() => void openDrawer()}
              disabled={busy}
              className="rounded-lg bg-amber-600 px-4 py-2 text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {busy ? t("pos.cash_session.opening") : t("pos.cash_session.open_button")}
            </button>
            {state.canSeeHistory && (
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="rounded-lg border border-amber-300 bg-white px-4 py-2 text-amber-900 hover:bg-amber-100"
              >
                {t("pos.cash_session.history_button")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-green-300 bg-green-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="font-semibold text-green-900">{t("pos.cash_session.open_title")}</div>
            <p className="text-sm text-green-900/80">
              {t("pos.cash_session.open_since", {
                name: session.openedBy?.name || t("pos.cash_session.someone"),
                time: salonDateTime(session.openedAt, session.salon.timezone),
              })}
              {" · "}
              {t("pos.cash_session.float")} {euros(session.openingFloatCents)}
              {" · "}
              <strong>
                {t("pos.cash_session.expected_cash")} {euros(expected)}
              </strong>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setMovementOpen(true)}
              className="rounded-lg border border-green-300 bg-white px-4 py-2 text-green-900 hover:bg-green-100"
            >
              {t("pos.cash_session.movement_button")}
            </button>
            <button
              type="button"
              onClick={() => void startClose()}
              className="rounded-lg bg-green-700 px-4 py-2 text-white hover:bg-green-800"
            >
              {t("pos.cash_session.close_button")}
            </button>
            {state.canSeeHistory && (
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="rounded-lg border border-green-300 bg-white px-4 py-2 text-green-900 hover:bg-green-100"
              >
                {t("pos.cash_session.history_button")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Money in or out of the drawer */}
      {movementOpen && session && (
        <div role="dialog" aria-modal="true" aria-labelledby="cash-movement-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h2 id="cash-movement-title" className="mb-3 text-base font-semibold">
              {t("pos.cash_session.movement_title")}
            </h2>
            <div className="mb-3 flex gap-2" role="radiogroup">
              {(["in", "out"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={movementType === type}
                  onClick={() => setMovementType(type)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold ${
                    movementType === type ? "border-blue-600 bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {type === "in" ? t("pos.cash_session.movement_in") : t("pos.cash_session.movement_out")}
                </button>
              ))}
            </div>
            <p className="mb-3 text-xs text-gray-500">
              {movementType === "in" ? t("pos.cash_session.movement_in_hint") : t("pos.cash_session.movement_out_hint")}
            </p>
            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-gray-700">{t("pos.cash_session.amount_label")}</span>
              <input
                type="text"
                inputMode="decimal"
                value={movementAmount}
                onChange={(e) => setMovementAmount(e.target.value)}
                placeholder="0,00"
                className="w-full rounded-lg border px-3 py-2"
              />
            </label>
            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-gray-700">{t("pos.cash_session.reason_label")}</span>
              <input
                type="text"
                maxLength={300}
                value={movementReason}
                onChange={(e) => setMovementReason(e.target.value)}
                placeholder={t("pos.cash_session.reason_placeholder")}
                className="w-full rounded-lg border px-3 py-2"
              />
            </label>
            {movementIssue && (movementAmount || movementReason) && (
              <p className="mb-3 text-xs text-red-700">{t(movementIssue)}</p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setMovementOpen(false)} className="rounded border px-4 py-2 text-sm hover:bg-gray-50">
                {t("pos.cash_session.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void saveMovement()}
                disabled={busy || !!movementIssue}
                className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:bg-blue-300"
              >
                {busy ? t("pos.cash_session.saving") : t("pos.cash_session.save_movement")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Closing: the figures, the count, the difference */}
      {closing && session && (
        <div role="dialog" aria-modal="true" aria-labelledby="cash-close-title" className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg bg-white p-6 shadow-xl">
            <h2 id="cash-close-title" className="mb-1 text-base font-semibold">
              {t("pos.cash_session.close_title")}
            </h2>
            <p className="mb-4 text-sm text-gray-600">{t("pos.cash_session.close_intro")}</p>

            <h3 className="mb-1 text-sm font-semibold">{t("pos.cash_session.by_method")}</h3>
            {session.figures.byMethod.length === 0 ? (
              <p className="mb-4 text-sm text-gray-500">{t("pos.cash_session.no_payments")}</p>
            ) : (
              <table className="mb-4 w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="py-1 font-medium">{t("pos.cash_session.method")}</th>
                    <th className="py-1 text-right font-medium">{t("pos.cash_session.payments_count")}</th>
                    <th className="py-1 text-right font-medium">{t("pos.cash_session.amount")}</th>
                    <th className="py-1 text-right font-medium">{t("pos.cash_session.refunded")}</th>
                  </tr>
                </thead>
                <tbody>
                  {session.figures.byMethod.map((m) => (
                    <tr key={m.method} className="border-t">
                      <td className="py-1">{methodLabel(m.method)}</td>
                      <td className="py-1 text-right">{m.count}</td>
                      <td className="py-1 text-right">{euros(m.amountCents)}</td>
                      <td className="py-1 text-right">{m.refundedCents ? `−${euros(m.refundedCents)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3 className="mb-1 text-sm font-semibold">{t("pos.cash_session.cash_drawer")}</h3>
            <div className="mb-4 space-y-0.5 text-sm">
              <div className="flex justify-between">
                <span>{t("pos.cash_session.opening_float")}</span>
                <span>{euros(session.figures.cash.openingFloatCents)}</span>
              </div>
              <div className="flex justify-between">
                <span>{t("pos.cash_session.cash_sales")}</span>
                <span>+{euros(session.figures.cash.salesCents)}</span>
              </div>
              {session.figures.cash.refundsCents > 0 && (
                <div className="flex justify-between">
                  <span>{t("pos.cash_session.cash_refunds")}</span>
                  <span>−{euros(session.figures.cash.refundsCents)}</span>
                </div>
              )}
              {session.figures.cash.movementsInCents > 0 && (
                <div className="flex justify-between">
                  <span>{t("pos.cash_session.movements_in")}</span>
                  <span>+{euros(session.figures.cash.movementsInCents)}</span>
                </div>
              )}
              {session.figures.cash.movementsOutCents > 0 && (
                <div className="flex justify-between">
                  <span>{t("pos.cash_session.movements_out")}</span>
                  <span>−{euros(session.figures.cash.movementsOutCents)}</span>
                </div>
              )}
              <div className="flex justify-between border-t pt-1 font-semibold">
                <span>{t("pos.cash_session.expected")}</span>
                <span>{euros(expected)}</span>
              </div>
            </div>

            {!showCount ? (
              <label className="mb-2 block text-sm">
                <span className="mb-1 block font-semibold">{t("pos.cash_session.counted_label")}</span>
                <input
                  type="text"
                  inputMode="decimal"
                  autoFocus
                  value={countedText}
                  onChange={(e) => setCountedText(e.target.value)}
                  placeholder="0,00"
                  className="w-40 rounded-lg border px-3 py-2 text-lg"
                />
              </label>
            ) : (
              <div className="mb-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                {DENOMINATIONS.map((cents) => (
                  <label key={cents} className="flex items-center justify-between gap-2 text-sm">
                    <span className="w-16">{denominationLabel(cents)}</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label={denominationLabel(cents)}
                      value={countRows[cents] ?? ""}
                      onChange={(e) => setCountRows((rows) => ({ ...rows, [cents]: e.target.value }))}
                      className="w-16 rounded border px-2 py-1 text-right"
                    />
                  </label>
                ))}
                <div className="col-span-full mt-1 text-sm font-semibold">
                  {countTotal === null ? t("pos.cash_session.err_counted") : t("pos.cash_session.count_total", { amount: euros(countTotal) })}
                </div>
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowCount((v) => !v)}
              className="mb-3 text-sm text-blue-700 underline"
            >
              {showCount ? t("pos.cash_session.count_helper_hide") : t("pos.cash_session.count_helper")}
            </button>

            {diff !== null && (countedText || showCount) && (
              <div className={`mb-3 rounded border px-3 py-2 text-center font-semibold ${discrepancyClass(diff)}`} aria-live="polite">
                {t("pos.cash_session.difference")}: {diffText(diff)}
              </div>
            )}

            <label className="mb-4 block text-sm">
              <span className="mb-1 block text-gray-700">{t("pos.cash_session.notes_label")}</span>
              <textarea
                maxLength={500}
                rows={2}
                value={closeNotes}
                onChange={(e) => setCloseNotes(e.target.value)}
                className="w-full rounded-lg border px-3 py-2"
              />
            </label>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setClosing(false)} className="rounded border px-4 py-2 text-sm hover:bg-gray-50">
                {t("pos.cash_session.cancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (countedCents === null || (!showCount && !countedText.trim())) {
                    toast({ title: t("pos.cash_session.close_failed"), description: t("pos.cash_session.err_counted"), variant: "destructive" });
                    return;
                  }
                  setConfirmClose(true);
                }}
                disabled={busy}
                className="rounded bg-green-700 px-4 py-2 text-sm text-white hover:bg-green-800 disabled:opacity-50"
              >
                {t("pos.cash_session.review_close")}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmClose && countedCents !== null}
        title={t("pos.cash_session.confirm_title", { amount: euros(countedCents ?? 0) })}
        description={
          <div className="space-y-2">
            {diff === 0 ? (
              <p>{t("pos.cash_session.confirm_desc_square", { expected: euros(expected) })}</p>
            ) : (
              <p className={`rounded border px-2 py-1 ${discrepancyClass(diff ?? 0)}`}>
                {t("pos.cash_session.confirm_desc_diff", { expected: euros(expected), diff: diffText(diff ?? 0) })}
              </p>
            )}
            <p>{t("pos.cash_session.confirm_desc_after")}</p>
          </div>
        }
        confirmLabel={busy ? t("pos.cash_session.closing") : t("pos.cash_session.confirm_button")}
        cancelLabel={t("pos.cash_session.cancel")}
        destructive={diff !== null && diff !== 0}
        loading={busy}
        onCancel={() => setConfirmClose(false)}
        onConfirm={() => void closeDrawer()}
      />

      {historyOpen && <CashHistory onClose={() => setHistoryOpen(false)} onView={(s) => setReport(s)} />}
      {report && <CashSessionReport session={report} onClose={() => setReport(null)} />}
    </>
  );
}

/** Past sessions, newest first, with their differences (owner and managers). */
function CashHistory({ onClose, onView }: { onClose: () => void; onView: (s: CashSessionView) => void }) {
  const t = useTranslations();
  const { toast } = useToast();
  const diffText = useDiscrepancyText();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<CashSessionList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiClient
      .getCashSessions({ from: from || undefined, to: to || undefined, page, limit: 20 })
      .then((l) => alive && (setList(l), setError(null)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : t("pos.cash_session.load_failed")));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, page]);

  const view = async (id: string) => {
    try {
      onView(await apiClient.getCashSession(id));
    } catch (e: any) {
      toast({ title: t("pos.cash_session.load_failed"), description: e?.message, variant: "destructive" });
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="cash-history-title" className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 id="cash-history-title" className="text-base font-semibold">
            {t("pos.cash_session.history_title")}
          </h2>
          <button type="button" onClick={onClose} className="rounded border px-3 py-1 text-sm hover:bg-gray-50">
            {t("pos.cash_session.close")}
          </button>
        </div>
        <div className="mb-3 flex flex-wrap gap-3 text-sm">
          <label>
            <span className="mr-1">{t("pos.cash_session.history_from")}</span>
            <input type="date" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} className="rounded border px-2 py-1" />
          </label>
          <label>
            <span className="mr-1">{t("pos.cash_session.history_to")}</span>
            <input type="date" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} className="rounded border px-2 py-1" />
          </label>
        </div>
        {error && (
          <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {!list && !error && <p className="text-sm text-gray-500">{t("pos.cash_session.loading")}</p>}
        {list && list.sessions.length === 0 && <p className="text-sm text-gray-500">{t("pos.cash_session.history_empty")}</p>}
        {list && list.sessions.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500">
                    <th className="py-1 pr-2 font-medium">{t("pos.cash_session.opened_at")}</th>
                    <th className="py-1 pr-2 font-medium">{t("pos.cash_session.closed_at")}</th>
                    <th className="py-1 pr-2 text-right font-medium">{t("pos.cash_session.float")}</th>
                    <th className="py-1 pr-2 text-right font-medium">{t("pos.cash_session.expected")}</th>
                    <th className="py-1 pr-2 text-right font-medium">{t("pos.cash_session.counted")}</th>
                    <th className="py-1 pr-2 text-right font-medium">{t("pos.cash_session.difference")}</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {list.sessions.map((s) => (
                    <tr key={s.id} className="border-t">
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {new Date(s.openedAt).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}
                        <div className="text-xs text-gray-500">{s.openedBy?.name || t("pos.cash_session.someone")}</div>
                      </td>
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {s.status === "open" ? (
                          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">{t("pos.cash_session.status_open")}</span>
                        ) : (
                          <>
                            {s.closedAt ? new Date(s.closedAt).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }) : "—"}
                            <div className="text-xs text-gray-500">{s.closedBy?.name || t("pos.cash_session.someone")}</div>
                          </>
                        )}
                      </td>
                      <td className="py-1 pr-2 text-right">{euros(s.openingFloatCents)}</td>
                      <td className="py-1 pr-2 text-right">{s.expectedCashCents != null ? euros(s.expectedCashCents) : "—"}</td>
                      <td className="py-1 pr-2 text-right">{s.countedCashCents != null ? euros(s.countedCashCents) : "—"}</td>
                      <td className="py-1 pr-2 text-right">
                        {s.discrepancyCents != null ? (
                          <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${discrepancyClass(s.discrepancyCents)}`}>
                            {diffText(s.discrepancyCents)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-1 text-right">
                        <button type="button" onClick={() => void view(s.id)} className="text-blue-700 underline">
                          {t("pos.cash_session.view")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list.totals.closedSessions > 0 && (
              <p className="mt-3 text-sm">
                {t("pos.cash_session.history_total_diff", { amount: diffText(list.totals.discrepancyCents) })}
              </p>
            )}
            {list.pagination.totalPages > 1 && (
              <div className="mt-3 flex items-center justify-end gap-2 text-sm">
                <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border px-3 py-1 disabled:opacity-50">
                  {t("pos.cash_session.previous")}
                </button>
                <span>{t("pos.cash_session.page", { page, total: list.pagination.totalPages })}</span>
                <button
                  type="button"
                  disabled={page >= list.pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="rounded border px-3 py-1 disabled:opacity-50"
                >
                  {t("pos.cash_session.next")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
