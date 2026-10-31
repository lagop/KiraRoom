/**
 * For specs: an in-memory stand-in for the Prisma calls InvoiceService makes
 * to issue and rectify invoices (numbering, create, the lookups of the
 * original and of its earlier rectificativas, the row lock). Rows keep their
 * lines, as `include: { lines: true }` returns them. No jest here: this file
 * is compiled with the app.
 */
export function invoiceStore(fiscalSettings: Record<string, unknown> = { defaultSeries: "A", defaultTaxRate: 21 }) {
  const invoices = new Map<string, any>();
  const counters = new Map<string, number>();
  const locks: string[] = [];

  const matches = (row: any, where: any = {}): boolean =>
    Object.entries(where).every(([key, cond]: [string, any]) => {
      if (key === "OR") return (cond as any[]).some((c) => matches(row, c));
      if (key === "notes") return typeof row.notes === "string" && row.notes.startsWith(cond.startsWith);
      if (key === "lines") {
        const ids: string[] = cond.some.rectifiesLineId.in;
        return row.lines.some((l: any) => ids.includes(l.rectifiesLineId));
      }
      if (cond && typeof cond === "object" && "not" in cond) return row[key] !== cond.not;
      if (cond && typeof cond === "object" && "in" in cond) return cond.in.includes(row[key]);
      return row[key] === cond;
    });

  const pick = (row: any, select?: any): any => {
    if (!select) return row;
    return Object.fromEntries(
      Object.entries(select).map(([key, sub]: [string, any]) => [
        key,
        key === "lines" && sub?.select ? row.lines.map((l: any) => pick(l, sub.select)) : row[key],
      ]),
    );
  };

  const prisma: any = {
    tenant: { findUnique: async () => ({ fiscalMode: "none", fiscalSettings }) },
    fiscalSequence: {
      upsert: async () => ({}),
      update: async ({ where }: any) => {
        const k = JSON.stringify(where.tenantId_series_year);
        counters.set(k, (counters.get(k) ?? 0) + 1);
        return { lastNumber: counters.get(k) };
      },
    },
    invoice: {
      create: async (args: any) => {
        const id = `inv-${invoices.size + 1}`;
        const { lines, ...rest } = args.data;
        const row = {
          id,
          ...rest,
          lines: lines.create.map((l: any, i: number) => ({ id: `${id}-line-${i + 1}`, invoiceId: id, ...l })),
        };
        invoices.set(id, row);
        return row;
      },
      findFirst: async ({ where, select }: any) => {
        const row = [...invoices.values()].find((r) => matches(r, where));
        return row ? pick(row, select) : null;
      },
      findMany: async ({ where, select }: any) =>
        [...invoices.values()].filter((r) => matches(r, where)).map((r) => pick(r, select)),
      update: async ({ where, data }: any) => Object.assign(invoices.get(where.id), data),
    },
    // SELECT ... FOR UPDATE on the original: recorded, nothing to wait for here.
    $queryRaw: async (_sql: TemplateStringsArray, ...values: unknown[]) => {
      locks.push(String(values[0]));
      return [];
    },
    $transaction: async (fn: any) => fn(prisma),
  };
  return { prisma, invoices, locks };
}
