/**
 * The invoices screen: its list query (search, dates, real statuses, pages),
 * the server's answer read as a page, the salon's "today" for a new invoice,
 * and the rectificativa body.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/invoice-list.spec.ts
 */
import {
  dayInZone,
  INVOICE_STATUS_FILTERS,
  invoiceListQuery,
  invoicePage,
  parseEuros,
  rectifyBody,
} from "./invoice-list";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}
function same(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

console.log("list query");
same("first page, no filters: nothing", invoiceListQuery({ page: 1 }), {});
same(
  "search, dates (new and older names, the older toDate to the end of the day), status and page",
  invoiceListQuery({ page: 3, q: "  Ana  ", dateFrom: "2026-10-01", dateTo: "2026-10-31", status: "cancelled" }),
  {
    page: "3",
    q: "Ana",
    dateFrom: "2026-10-01",
    fromDate: "2026-10-01",
    dateTo: "2026-10-31",
    toDate: "2026-10-31T23:59:59.999Z",
    status: "cancelled",
  },
);
same("'all' sends no status", invoiceListQuery({ page: 1, status: "all" }), {});
same("only real statuses: Todas, Emitida, Anulada", [...INVOICE_STATUS_FILTERS], ["all", "issued", "cancelled"]);

console.log("page");
{
  const full = Array.from({ length: 50 }, (_, i) => i);
  same("a full array page may have more", invoicePage(full, 1).hasNext, true);
  same("a short array page is the last", invoicePage([1, 2], 2), { items: [1, 2], total: null, hasNext: false });
  same("{ items, total } says how many", invoicePage({ items: [1], total: 120, limit: 50 }, 2), { items: [1], total: 120, hasNext: true });
  same("{ data, total }: last page", invoicePage({ data: [1], total: 101 }, 3), { items: [1], total: 101, hasNext: false });
  same("nothing usable: empty", invoicePage(null, 1), { items: [], total: null, hasNext: false });
}

console.log("the salon's today");
{
  // 23:30 UTC on 31 October: 1 November in Madrid, still 31 October in the Canaries.
  const instant = Date.UTC(2026, 9, 31, 23, 30);
  same("Madrid", dayInZone(instant, "Europe/Madrid"), "2026-11-01");
  same("Canarias", dayInZone(instant, "Atlantic/Canary"), "2026-10-31");
  same("an unknown zone: Madrid", dayInZone(instant, "Nowhere/Land"), "2026-11-01");
}

console.log("rectificativa");
same("a reason is required", rectifyBody({ mode: "full", reason: "  " }), { error: "Indica el motivo de la rectificativa." });
same("whole invoice: no lines", rectifyBody({ mode: "full", reason: " Cobro duplicado " }), { body: { reason: "Cobro duplicado" } });
same(
  "chosen lines: minus the units given back, untouched lines left out",
  rectifyBody({
    mode: "lines",
    reason: "Devolución",
    lines: [
      { originalLineId: "l1", quantity: 1 },
      { originalLineId: "l2", quantity: 0 },
    ],
  }),
  { body: { reason: "Devolución", lines: [{ originalLineId: "l1", quantity: -1 }] } },
);
same(
  "no line chosen: says so",
  rectifyBody({ mode: "lines", reason: "x", lines: [{ originalLineId: "l1", quantity: 0 }] }),
  { error: "Elige al menos una línea y cuántas unidades se devuelven." },
);
same(
  "an amount: one free line of minus that amount, tax included",
  rectifyBody({ mode: "amount", reason: "Descuento", amountCents: 500, taxRate: 21 }),
  {
    body: {
      reason: "Descuento",
      lines: [{ description: "Abono", quantity: -1, unitPriceCents: 500, taxRate: 21, taxIncluded: true }],
    },
  },
);
same("an amount of zero is refused", rectifyBody({ mode: "amount", reason: "x", amountCents: 0 }), {
  error: "Indica el importe a abonar, mayor que cero.",
});
same("euros typed the Spanish way", [parseEuros("12,50"), parseEuros("12.5"), parseEuros("7 €"), parseEuros("abc")].map(String), [
  "1250",
  "1250",
  "700",
  "NaN",
]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
