/**
 * The cash drawer at the till (apertura y cierre de caja, arqueo), the
 * panel's side: the count by coin and note, the difference with what the
 * drawer should hold, and whether a ticket may be charged with the drawer
 * as it is. Amounts in cents. The server decides (cash-sessions.service.ts);
 * this says it before asking.
 */

/** Euro coins and notes, largest first, in cents. */
export const DENOMINATIONS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

/** Pieces counted of each coin or note, as typed: { 5000: "2" }. */
export type CountRows = Record<number, string>;

/** "50 €", "2 €", "50 cent". */
export function denominationLabel(cents: number): string {
  return cents >= 100 ? `${cents / 100} €` : `${cents} cent`;
}

/** Pieces typed for a coin or note: a whole number of 0 or more, else null. */
export function parsePieces(text: string | undefined): number | null {
  const clean = (text ?? "").trim();
  if (clean === "") return 0;
  if (!/^\d{1,6}$/.test(clean)) return null;
  return Number(clean);
}

/** What the count adds up to, or null while a row is not a whole number. */
export function countTotalCents(rows: CountRows): number | null {
  let total = 0;
  for (const cents of DENOMINATIONS) {
    const pieces = parsePieces(rows[cents]);
    if (pieces === null) return null;
    total += pieces * cents;
  }
  return total;
}

/** The count as the server keeps it: only the coins and notes there are ({ "5000": 2 }). */
export function breakdownForServer(rows: CountRows): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const cents of DENOMINATIONS) {
    const pieces = parsePieces(rows[cents]);
    if (pieces) out[String(cents)] = pieces;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Counted minus expected: negative is money missing, positive money over. */
export function discrepancy(countedCents: number, expectedCents: number): number {
  return countedCents - expectedCents;
}

export type DiscrepancyTone = "square" | "short" | "over";

export function discrepancyTone(cents: number): DiscrepancyTone {
  if (cents === 0) return "square";
  return cents < 0 ? "short" : "over";
}

/** The colour of a difference: green square, red short, amber over. */
export function discrepancyClass(cents: number): string {
  const tone = discrepancyTone(cents);
  if (tone === "square") return "text-green-700 bg-green-50 border-green-200";
  if (tone === "short") return "text-red-700 bg-red-50 border-red-200";
  return "text-amber-800 bg-amber-50 border-amber-200";
}

/**
 * Why the ticket cannot be charged with the drawer as it is (a translation
 * key, messages/*.json): cash goes into the drawer, so it needs it open;
 * card, Bizum and the rest do not. Null while the drawer's state is not
 * known yet (the server decides anyway).
 */
export function drawerProblem(
  tenders: Array<{ method: string; amount: number }>,
  drawerOpen: boolean | null,
): string | null {
  if (drawerOpen !== false) return null;
  if (!tenders.some((t) => t.method === "cash" && t.amount > 0)) return null;
  return "pos.cash_session.err_drawer_closed";
}

/** Why a movement cannot be recorded yet (a translation key), or null. */
export function movementProblem(amountCents: number | null, reason: string, type: "in" | "out", expectedCents: number): string | null {
  if (amountCents === null || amountCents <= 0) return "pos.cash_session.err_amount";
  if (!reason.trim()) return "pos.cash_session.err_reason";
  if (type === "out" && amountCents > expectedCents) return "pos.cash_session.err_out_too_much";
  return null;
}
