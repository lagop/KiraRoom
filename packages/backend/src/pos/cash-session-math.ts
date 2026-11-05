/**
 * The arithmetic of a cash-drawer session (arqueo), in cents. Pure: the
 * service reads the rows and this works out what the drawer should hold.
 *
 * The drawer holds, at any time:
 *
 *     opening float
 *   + cash taken at the till, net of the change given back
 *     (a cash payment is recorded already net of change: pos-tenders.ts)
 *   - cash given back as refunds while the session was open
 *   + cash handed over to load a client's wallet (a top-up: money the
 *     salon owes her in services, not a sale)
 *   - cash handed back to a client from her wallet (a withdrawal)
 *   + cash put in   (movements "in": more change, ...)
 *   - cash taken out (movements "out": a supplier paid from the drawer,
 *     takings to the bank, ...)
 *
 * The cash part of a mixed payment (cash + card) is its own payment row
 * with method cash, so it counts here and the card part does not.
 */

export interface SessionPaymentRow {
  method: string;
  amount: number;
}

export interface SessionRefundRow {
  /** The method of the payment it gives back. */
  method: string;
  amount: number;
}

export interface SessionSaleRow {
  totalCents: number;
  subtotalCents: number;
  discountCents: number;
  loyaltyDiscountCents: number;
  changeCents: number;
}

/** A wallet top-up taken (or a withdrawal handed back) while the session was open, with how. */
export interface SessionWalletTopUpRow {
  method: string;
  amount: number;
}
export type SessionWalletWithdrawalRow = SessionWalletTopUpRow;

export interface SessionMovementRow {
  type: 'in' | 'out';
  amountCents: number;
}

export interface SessionInput {
  openingFloatCents: number;
  payments: SessionPaymentRow[];
  refunds: SessionRefundRow[];
  sales: SessionSaleRow[];
  /** The tax inside the session's sale lines (gift cards carry none). */
  taxCents: number;
  movements: SessionMovementRow[];
  /** Wallet top-ups: they count in their method (cash in the drawer, card at the terminal), not as sales. */
  walletTopUps?: SessionWalletTopUpRow[];
  /** Wallet withdrawals: money handed back in their method (cash out of the drawer). */
  walletWithdrawals?: SessionWalletWithdrawalRow[];
}

export interface MethodTotal {
  method: string;
  /** Payments taken with it, wallet top-ups included. */
  count: number;
  amountCents: number;
  /** Of amountCents, wallet top-ups (prepaid money, not sales). */
  topUpCents: number;
  /** Given back with it during the session (refunds). */
  refundedCents: number;
  /** Handed back with it from clients' wallets (withdrawals). */
  walletWithdrawnCents: number;
  /** Taken minus given back (refunds and wallet withdrawals). */
  netCents: number;
}

export interface CashFigures {
  openingFloatCents: number;
  /** Cash kept from sales (net of change). */
  salesCents: number;
  /** Change handed back from the drawer. */
  changeGivenCents: number;
  /** What clients handed over in cash: kept + change. */
  tenderedCents: number;
  refundsCents: number;
  /** Cash handed over to load clients' wallets. */
  walletTopUpsCents: number;
  /** Cash handed back from clients' wallets. */
  walletWithdrawalsCents: number;
  movementsInCents: number;
  movementsOutCents: number;
  expectedCents: number;
}

export interface SessionFigures {
  byMethod: MethodTotal[];
  cash: CashFigures;
  sales: {
    count: number;
    /** What the sales charged, tax included, after discounts. */
    grossCents: number;
    /** Before the till's discounts and points. */
    subtotalCents: number;
    discountCents: number;
    loyaltyDiscountCents: number;
    taxCents: number;
    /** Gross minus tax. */
    netCents: number;
  };
  refunds: { count: number; totalCents: number };
  /** Wallet top-ups, every method. */
  walletTopUps: { count: number; totalCents: number };
  /** Wallet withdrawals, every method. */
  walletWithdrawals: { count: number; totalCents: number };
}

/** The order the report lists methods in; others (should there be any) after. */
const METHOD_ORDER = ['cash', 'card', 'bizum', 'bank_transfer', 'wallet', 'gift_card', 'loyalty_points'];

/** What the drawer should hold. */
export function expectedCashCents(input: {
  openingFloatCents: number;
  cashSalesCents: number;
  cashRefundsCents: number;
  cashWalletTopUpsCents?: number;
  cashWalletWithdrawalsCents?: number;
  movementsInCents: number;
  movementsOutCents: number;
}): number {
  return (
    input.openingFloatCents +
    input.cashSalesCents -
    input.cashRefundsCents +
    (input.cashWalletTopUpsCents ?? 0) -
    (input.cashWalletWithdrawalsCents ?? 0) +
    input.movementsInCents -
    input.movementsOutCents
  );
}

/** Counted minus expected: negative is money missing, positive money over. */
export function discrepancyCents(countedCents: number, expectedCents: number): number {
  return countedCents - expectedCents;
}

export function sessionFigures(input: SessionInput): SessionFigures {
  const methods = new Map<string, MethodTotal>();
  const entry = (method: string) => {
    let m = methods.get(method);
    if (!m) {
      m = { method, count: 0, amountCents: 0, topUpCents: 0, refundedCents: 0, walletWithdrawnCents: 0, netCents: 0 };
      methods.set(method, m);
    }
    return m;
  };
  for (const p of input.payments) {
    const m = entry(p.method);
    m.count += 1;
    m.amountCents += p.amount;
  }
  const topUps = input.walletTopUps ?? [];
  for (const t of topUps) {
    const m = entry(t.method);
    m.count += 1;
    m.amountCents += t.amount;
    m.topUpCents += t.amount;
  }
  for (const r of input.refunds) entry(r.method).refundedCents += r.amount;
  const withdrawals = input.walletWithdrawals ?? [];
  for (const w of withdrawals) entry(w.method).walletWithdrawnCents += w.amount;
  for (const m of methods.values()) m.netCents = m.amountCents - m.refundedCents - m.walletWithdrawnCents;

  const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);
  const cashSales = sum(input.payments.filter((p) => p.method === 'cash'), (p) => p.amount);
  const cashRefunds = sum(input.refunds.filter((r) => r.method === 'cash'), (r) => r.amount);
  const cashTopUps = sum(topUps.filter((t) => t.method === 'cash'), (t) => t.amount);
  const cashWithdrawals = sum(withdrawals.filter((w) => w.method === 'cash'), (w) => w.amount);
  const movementsIn = sum(input.movements.filter((m) => m.type === 'in'), (m) => m.amountCents);
  const movementsOut = sum(input.movements.filter((m) => m.type === 'out'), (m) => m.amountCents);
  const change = sum(input.sales, (s) => s.changeCents);
  const gross = sum(input.sales, (s) => s.totalCents);

  const rank = (method: string) => {
    const i = METHOD_ORDER.indexOf(method);
    return i < 0 ? METHOD_ORDER.length : i;
  };
  return {
    byMethod: [...methods.values()].sort((a, b) => rank(a.method) - rank(b.method) || a.method.localeCompare(b.method)),
    cash: {
      openingFloatCents: input.openingFloatCents,
      salesCents: cashSales,
      changeGivenCents: change,
      tenderedCents: cashSales + change,
      refundsCents: cashRefunds,
      walletTopUpsCents: cashTopUps,
      walletWithdrawalsCents: cashWithdrawals,
      movementsInCents: movementsIn,
      movementsOutCents: movementsOut,
      expectedCents: expectedCashCents({
        openingFloatCents: input.openingFloatCents,
        cashSalesCents: cashSales,
        cashRefundsCents: cashRefunds,
        cashWalletTopUpsCents: cashTopUps,
        cashWalletWithdrawalsCents: cashWithdrawals,
        movementsInCents: movementsIn,
        movementsOutCents: movementsOut,
      }),
    },
    sales: {
      count: input.sales.length,
      grossCents: gross,
      subtotalCents: sum(input.sales, (s) => s.subtotalCents),
      discountCents: sum(input.sales, (s) => s.discountCents),
      loyaltyDiscountCents: sum(input.sales, (s) => s.loyaltyDiscountCents),
      taxCents: input.taxCents,
      netCents: gross - input.taxCents,
    },
    refunds: { count: input.refunds.length, totalCents: sum(input.refunds, (r) => r.amount) },
    walletTopUps: { count: topUps.length, totalCents: sum(topUps, (t) => t.amount) },
    walletWithdrawals: { count: withdrawals.length, totalCents: sum(withdrawals, (w) => w.amount) },
  };
}

/** The coins and notes the count helper offers, in cents. */
export const CASH_DENOMINATIONS = [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

/**
 * A count by coin and note ({ "5000": 2 }: two 50 € notes), checked: only
 * known denominations, whole non-negative pieces, and adding up to what was
 * counted. Null when none was sent. Throws a Spanish message otherwise.
 */
export function checkedBreakdown(
  breakdown: Record<string, unknown> | null | undefined,
  countedCents: number,
): Record<string, number> | null {
  if (breakdown == null) return null;
  const out: Record<string, number> = {};
  let total = 0;
  for (const [key, raw] of Object.entries(breakdown)) {
    const cents = Number(key);
    if (!(CASH_DENOMINATIONS as readonly number[]).includes(cents)) {
      throw new Error(`"${key}" no es una moneda ni un billete de euro.`);
    }
    const pieces = Number(raw);
    if (!Number.isInteger(pieces) || pieces < 0 || pieces > 100_000) {
      throw new Error('El número de monedas o billetes debe ser un entero de 0 o más.');
    }
    if (pieces === 0) continue;
    out[String(cents)] = pieces;
    total += cents * pieces;
  }
  if (total !== countedCents) {
    throw new Error('El desglose de monedas y billetes no suma el efectivo contado.');
  }
  return out;
}
