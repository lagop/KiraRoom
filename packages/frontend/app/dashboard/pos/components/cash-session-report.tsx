"use client";

import type { CashSessionBlindView, CashSessionFullView, CashSessionView } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { methodLabel } from "@/lib/payments-format";
import { euros } from "@/lib/pos-cart";
import { denominationLabel, discrepancyClass, discrepancyTone } from "@/lib/cash-session";

interface CashSessionReportProps {
  session: CashSessionView;
  onClose: () => void;
}

/** "01/11/2026 09:30" on the salon's clock. */
export function salonDateTime(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-ES", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(iso).toLocaleString("es-ES");
  }
}

/** "Falta 5,00 €", "Sobra 2,00 €", "Cuadra". */
export function useDiscrepancyText() {
  const t = useTranslations();
  return (cents: number) => {
    const tone = discrepancyTone(cents);
    if (tone === "square") return t("pos.cash_session.square");
    return t(tone === "short" ? "pos.cash_session.short" : "pos.cash_session.over", { amount: euros(Math.abs(cents)) });
  };
}

/**
 * The closing report of a cash-drawer session (arqueo), or a partial one of
 * the open session: what was taken by method, the cash in the drawer, the
 * count and the difference, the sales, tax and refunds. "Imprimir" prints
 * only the report, 80 mm wide like the sale receipt (thermal printers).
 *
 * Staff (blind count) get a slip instead: when the drawer was opened and
 * closed, what they counted and their own movements, with no totals. The
 * server sends them nothing else (session.blind).
 */
export default function CashSessionReport({ session, onClose }: CashSessionReportProps) {
  const t = useTranslations();
  const closed = session.status === "closed";
  const title = session.blind
    ? closed
      ? t("pos.cash_session.report_blind_title")
      : t("pos.cash_session.report_blind_open_title")
    : closed
      ? t("pos.cash_session.report_title")
      : t("pos.cash_session.report_partial_title");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 print:static print:bg-transparent print:p-0">
      <style>{`
        @media print {
          @page { size: 80mm auto; margin: 3mm; }
          body * { visibility: hidden !important; }
          #cash-session-report, #cash-session-report * { visibility: visible !important; }
          #cash-session-report { position: absolute; left: 0; top: 0; width: 74mm; font-size: 11px; box-shadow: none; }
          .cash-report-actions { display: none !important; }
        }
      `}</style>
      <div className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-lg bg-white shadow-xl">
        <div id="cash-session-report" className="p-4 font-mono text-sm text-gray-900">
          <div className="text-center">
            <div className="font-bold">{session.salon.name}</div>
            <div>{title}</div>
          </div>
          <div className="my-2 border-t border-dashed" />
          {session.blind ? <BlindSlipBody session={session} /> : <FullReportBody session={session} />}
        </div>

        <div className="cash-report-actions flex justify-end gap-2 border-t p-4">
          <button type="button" onClick={onClose} className="rounded border px-4 py-2 text-sm hover:bg-gray-50">
            {t("pos.cash_session.close")}
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            {t("pos.cash_session.print")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** What both views print: a row, who opened and closed it, the count by coin, the movements, the notes. */
function useReportParts(session: CashSessionView) {
  const t = useTranslations();
  const tz = session.salon.timezone;
  const closed = session.status === "closed";
  const who = (p: { name: string | null } | null) => p?.name || t("pos.cash_session.someone");
  const row = (label: string, value: string, strong = false) => (
    <div className={`flex justify-between gap-2 ${strong ? "font-bold" : ""}`}>
      <span>{label}</span>
      <span className="whitespace-nowrap">{value}</span>
    </div>
  );
  const header = (
    <>
      {row(t("pos.cash_session.opened_at"), salonDateTime(session.openedAt, tz))}
      {row(t("pos.cash_session.opened_by"), who(session.openedBy))}
      {closed && row(t("pos.cash_session.closed_at"), salonDateTime(session.closedAt, tz))}
      {closed && row(t("pos.cash_session.closed_by"), who(session.closedBy))}
    </>
  );
  const breakdown = session.countBreakdown && Object.keys(session.countBreakdown).length > 0 && (
    <div className="mt-1 text-xs">
      {Object.entries(session.countBreakdown)
        .sort((a, b) => Number(b[0]) - Number(a[0]))
        .map(([cents, pieces]) => (
          <div key={cents} className="flex justify-between">
            <span>
              {pieces} × {denominationLabel(Number(cents))}
            </span>
            <span>{euros(Number(cents) * pieces)}</span>
          </div>
        ))}
    </div>
  );
  const movements = (title: string) => (
    <>
      <div className="font-bold">{title}</div>
      {session.movements.length === 0 && <div className="text-xs">{t("pos.cash_session.no_movements")}</div>}
      {session.movements.map((m) => (
        <div key={m.id} className="text-xs">
          {row(
            `${salonDateTime(m.createdAt, tz).slice(-5)} ${m.type === "in" ? t("pos.cash_session.movement_in") : t("pos.cash_session.movement_out")}`,
            `${m.type === "in" ? "+" : "−"}${euros(m.amountCents)}`,
          )}
          <div className="pl-2 break-words">
            {m.reason} · {who(m.createdBy ?? null)}
          </div>
        </div>
      ))}
    </>
  );
  const notes = (session.openingNotes || session.closingNotes) && (
    <>
      <div className="my-2 border-t border-dashed" />
      <div className="font-bold">{t("pos.cash_session.notes")}</div>
      {session.openingNotes && <div className="text-xs break-words">{session.openingNotes}</div>}
      {session.closingNotes && <div className="text-xs break-words">{session.closingNotes}</div>}
    </>
  );
  return { t, closed, row, header, breakdown, movements, notes };
}

/** Staff: the times, the float, what they counted and their own movements. No totals. */
function BlindSlipBody({ session }: { session: CashSessionBlindView }) {
  const { t, closed, row, header, breakdown, movements, notes } = useReportParts(session);
  return (
    <>
      {header}
      <div className="my-2 border-t border-dashed" />
      {row(t("pos.cash_session.opening_float"), euros(session.openingFloatCents))}
      {closed && session.countedCashCents !== null && row(t("pos.cash_session.counted"), euros(session.countedCashCents), true)}
      {breakdown}
      <div className="my-2 border-t border-dashed" />
      {movements(t("pos.cash_session.your_movements"))}
      {notes}
    </>
  );
}

/** The owner and managers: the figures, what the drawer should hold, the count and the difference. */
function FullReportBody({ session }: { session: CashSessionFullView }) {
  const { t, closed, row, header, breakdown, movements, notes } = useReportParts(session);
  const diffText = useDiscrepancyText();
  const f = session.figures;
  return (
    <>
      {header}

      <div className="my-2 border-t border-dashed" />
      <div className="font-bold">{t("pos.cash_session.by_method")}</div>
      {f.byMethod.length === 0 && <div className="text-xs">{t("pos.cash_session.no_payments")}</div>}
      {f.byMethod.map((m) => (
        <div key={m.method}>
          {row(`${methodLabel(m.method)} (${m.count})`, euros(m.amountCents))}
          {m.topUpCents > 0 && row(`  ${t("pos.cash_session.of_which_top_ups")}`, euros(m.topUpCents))}
          {m.refundedCents > 0 && row(`  ${t("pos.cash_session.refunded")}`, `−${euros(m.refundedCents)}`)}
          {m.walletWithdrawnCents > 0 && row(`  ${t("pos.cash_session.wallet_withdrawn")}`, `−${euros(m.walletWithdrawnCents)}`)}
        </div>
      ))}

      <div className="my-2 border-t border-dashed" />
      <div className="font-bold">{t("pos.cash_session.cash_drawer")}</div>
      {row(t("pos.cash_session.opening_float"), euros(f.cash.openingFloatCents))}
      {row(t("pos.cash_session.cash_sales"), `+${euros(f.cash.salesCents)}`)}
      {f.cash.changeGivenCents > 0 && (
        <div className="text-xs">{row(`  ${t("pos.cash_session.change_given")}`, euros(f.cash.changeGivenCents))}</div>
      )}
      {f.cash.walletTopUpsCents > 0 && row(t("pos.cash_session.wallet_top_ups_cash"), `+${euros(f.cash.walletTopUpsCents)}`)}
      {f.cash.walletWithdrawalsCents > 0 &&
        row(t("pos.cash_session.wallet_withdrawals_cash"), `−${euros(f.cash.walletWithdrawalsCents)}`)}
      {f.cash.refundsCents > 0 && row(t("pos.cash_session.cash_refunds"), `−${euros(f.cash.refundsCents)}`)}
      {f.cash.movementsInCents > 0 && row(t("pos.cash_session.movements_in"), `+${euros(f.cash.movementsInCents)}`)}
      {f.cash.movementsOutCents > 0 && row(t("pos.cash_session.movements_out"), `−${euros(f.cash.movementsOutCents)}`)}
      {row(t("pos.cash_session.expected"), euros(session.expectedCashCents ?? f.cash.expectedCents), true)}
      {closed && session.countedCashCents !== null && (
        <>
          {row(t("pos.cash_session.counted"), euros(session.countedCashCents), true)}
          <div className={`mt-1 rounded border px-2 py-1 text-center font-bold ${discrepancyClass(session.discrepancyCents ?? 0)}`}>
            {t("pos.cash_session.difference")}: {diffText(session.discrepancyCents ?? 0)}
          </div>
        </>
      )}
      {breakdown}

      <div className="my-2 border-t border-dashed" />
      {row(t("pos.cash_session.sales_count"), String(f.sales.count))}
      {f.sales.discountCents > 0 && row(t("pos.cash_session.discounts"), `−${euros(f.sales.discountCents)}`)}
      {f.sales.loyaltyDiscountCents > 0 && row(t("pos.cash_session.loyalty_discounts"), `−${euros(f.sales.loyaltyDiscountCents)}`)}
      {row(t("pos.cash_session.gross"), euros(f.sales.grossCents), true)}
      {row(t("pos.cash_session.net"), euros(f.sales.netCents))}
      {row(t("pos.cash_session.tax"), euros(f.sales.taxCents))}
      {f.refunds.count > 0 && row(`${t("pos.cash_session.refunds")} (${f.refunds.count})`, `−${euros(f.refunds.totalCents)}`)}
      {f.walletTopUps.count > 0 &&
        row(`${t("pos.cash_session.wallet_top_ups")} (${f.walletTopUps.count})`, euros(f.walletTopUps.totalCents))}
      {f.walletWithdrawals.count > 0 &&
        row(
          `${t("pos.cash_session.wallet_withdrawals")} (${f.walletWithdrawals.count})`,
          `−${euros(f.walletWithdrawals.totalCents)}`,
        )}

      <div className="my-2 border-t border-dashed" />
      {movements(t("pos.cash_session.movements"))}
      {notes}
    </>
  );
}
