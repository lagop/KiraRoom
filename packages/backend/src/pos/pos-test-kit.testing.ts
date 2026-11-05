/**
 * Test helpers for the till's specs: the tables a sale writes besides its
 * payments (PosSale, PosSaleLine) and the salon's settings, as in-memory
 * mocks. Not a spec itself (no `.spec.`): imported by them.
 */

type Row = Record<string, any>;

/** A salon whose prices include the tax (every new salon): money = catalogue. */
export const TAX_INCLUDED = { pricesIncludeTax: true, defaultTaxRate: 21 };
/** A salon from before the setting: prices are the base, tax on top. */
export const TAX_ON_TOP = { pricesIncludeTax: false, defaultTaxRate: 21 };

export function salonTenant(over: Row = {}): Row {
  return {
    fiscalSettings: TAX_INCLUDED,
    maxStaffDiscountPercent: 0,
    timezone: "Europe/Madrid",
    ...over,
  };
}

/** The cash-drawer session the specs' till has open (cash-session-lock.ts). */
export const OPEN_CASH_SESSION = "cs-open";

/**
 * A `$queryRaw` that answers the cash drawer's lock query (the session in
 * `store.cashSessionId`, OPEN_CASH_SESSION by default, none when null) and
 * hands any other raw query to `inner` (an invoice store's numbering...).
 */
export function cashDrawerRaw(
  store: { cashSessionId?: string | null },
  inner?: (sql: any, ...values: unknown[]) => Promise<unknown>,
) {
  return jest.fn(async (sql: any, ...values: unknown[]) => {
    const text = Array.isArray(sql) ? sql.join("?") : String(sql?.sql ?? sql);
    if (text.includes("cash_sessions")) {
      const id = store.cashSessionId === undefined ? OPEN_CASH_SESSION : store.cashSessionId;
      return id ? [{ id }] : [];
    }
    return inner ? inner(sql, ...values) : [];
  });
}

/**
 * The sale tables, recording into `store`. `sales` are keyed by id; a
 * second sale with the same (tenant, requestId) fails like the unique key.
 * The cash drawer is open: `store.cashSessionId` (OPEN_CASH_SESSION by
 * default; null: closed) answers the lock query of cash-session-lock.ts.
 */
export function saleTables(
  store: { sales: Row[]; lines: Row[]; cashSessionId?: string | null } = { sales: [], lines: [] },
) {
  return {
    store,
    $queryRaw: cashDrawerRaw(store),
    posSale: {
      create: jest.fn(async ({ data }: any) => {
        if (store.sales.some((s) => s.tenantId === data.tenantId && s.requestId === data.requestId)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { result: {}, createdAt: new Date(), ...data };
        store.sales.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = store.sales.find((s) => s.id === where.id);
        Object.assign(row ?? {}, data);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const key = where.tenantId_requestId;
        return store.sales.find((s) => s.tenantId === key.tenantId && s.requestId === key.requestId) ?? null;
      }),
      findFirst: jest.fn(async ({ where }: any) => store.sales.find((s) => s.id === where.id && s.tenantId === where.tenantId) ?? null),
    },
    posSaleLine: {
      createMany: jest.fn(async ({ data }: any) => {
        store.lines.push(...data);
        return { count: data.length };
      }),
      findMany: jest.fn(async ({ where }: any) => store.lines.filter((l) => !where?.saleId || l.saleId === where.saleId)),
    },
  };
}
