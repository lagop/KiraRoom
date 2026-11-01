"use client";

import type { CashSessionView } from "@/lib/api";
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
 */
export default function CashSessionReport({ session, onClose }: CashSessionReportProps) {
  const t = useTranslations();
  const diffText = useDiscrepancyText();
  const tz = session.salon.timezone;
  const f = session.figures;
  const closed = session.status === "closed";
  const who = (p: { name: string | null } | null) => p?.name || t("pos.cash_session.someone");
  const row = (label: string, value: string, strong = false) => (
    <div className={`flex justify-between gap-2 ${strong ? "font-bold" : ""}`}>
      <span>{label}</span>
      <span className="whitespace-nowrap">{value}</span>
    </div>
  );

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
            <div>{closed ? t("pos.cash_session.report_title") : t("pos.cash_session.report_partial_title")}</div>
          </div>
          <div className="my-2 border-t border-dashed" />
          {row(t("pos.cash_session.opened_at"), salonDateTime(session.openedAt, tz))}
          {row(t("pos.cash_session.opened_by"), who(session.openedBy))}
          {closed && row(t("pos.cash_session.closed_at"), salonDateTime(session.closedAt, tz))}
          {closed && row(t("pos.cash_session.closed_by"), who(session.closedBy))}

          <div className="my-2 border-t border-dashed" />
          <div className="font-bold">{t("pos.cash_session.by_method")}</div>
          {f.byMethod.length === 0 && <div className="text-xs">{t("pos.cash_session.no_payments")}</div>}
          {f.byMethod.map((m) => (
            <div key={m.method}>
              {row(`${methodLabel(m.method)} (${m.count})`, euros(m.amountCents))}
              {m.refundedCents > 0 && row(`  ${t("pos.cash_session.refunded")}`, `−${euros(m.refundedCents)}`)}
            </div>
          ))}

          <div className="my-2 border-t border-dashed" />
          <div className="font-bold">{t("pos.cash_session.cash_drawer")}</div>
          {row(t("pos.cash_session.opening_float"), euros(f.cash.openingFloatCents))}
          {row(t("pos.cash_session.cash_sales"), `+${euros(f.cash.salesCents)}`)}
          {f.cash.changeGivenCents > 0 && (
            <div className="text-xs">
              {row(`  ${t("pos.cash_session.change_given")}`, euros(f.cash.changeGivenCents))}
            </div>
          )}
          {f.cash.refundsCents > 0 && row(t("pos.cash_session.cash_refunds"), `−${euros(f.cash.refundsCents)}`)}
          {f.cash.movementsInCents > 0 && row(t("pos.cash_session.movements_in"), `+${euros(f.cash.movementsInCents)}`)}
          {f.cash.movementsOutCents > 0 && row(t("pos.cash_session.movements_out"), `−${euros(f.cash.movementsOutCents)}`)}
          {row(t("pos.cash_session.expected"), euros(session.expectedCashCents ?? f.cash.expectedCents), true)}
          {closed && session.countedCashCents !== null && (
            <>
              {row(t("pos.cash_session.counted"), euros(session.countedCashCents), true)}
              <div
                className={`mt-1 rounded border px-2 py-1 text-center font-bold ${discrepancyClass(session.discrepancyCents ?? 0)}`}
              >
                {t("pos.cash_session.difference")}: {diffText(session.discrepancyCents ?? 0)}
              </div>
            </>
          )}
          {session.countBreakdown && Object.keys(session.countBreakdown).length > 0 && (
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
          )}

          <div className="my-2 border-t border-dashed" />
          {row(t("pos.cash_session.sales_count"), String(f.sales.count))}
          {f.sales.discountCents > 0 && row(t("pos.cash_session.discounts"), `−${euros(f.sales.discountCents)}`)}
          {f.sales.loyaltyDiscountCents > 0 && row(t("pos.cash_session.loyalty_discounts"), `−${euros(f.sales.loyaltyDiscountCents)}`)}
          {row(t("pos.cash_session.gross"), euros(f.sales.grossCents), true)}
          {row(t("pos.cash_session.net"), euros(f.sales.netCents))}
          {row(t("pos.cash_session.tax"), euros(f.sales.taxCents))}
          {f.refunds.count > 0 && row(`${t("pos.cash_session.refunds")} (${f.refunds.count})`, `−${euros(f.refunds.totalCents)}`)}

          <div className="my-2 border-t border-dashed" />
          <div className="font-bold">{t("pos.cash_session.movements")}</div>
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

          {(session.openingNotes || session.closingNotes) && (
            <>
              <div className="my-2 border-t border-dashed" />
              <div className="font-bold">{t("pos.cash_session.notes")}</div>
              {session.openingNotes && <div className="text-xs break-words">{session.openingNotes}</div>}
              {session.closingNotes && <div className="text-xs break-words">{session.closingNotes}</div>}
            </>
          )}
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
