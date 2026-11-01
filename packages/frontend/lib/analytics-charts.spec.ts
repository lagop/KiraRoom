/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/analytics-charts.spec.ts
 *
 * The figures behind the analytics charts: donut arcs, the stacked monthly
 * evolution, the status shares of the insights, the daily line and the
 * request guard that keeps a slow, older answer from overwriting a newer one.
 */

import * as fs from "fs";
import * as path from "path";
import {
  DONUT_CIRCUMFERENCE,
  barWidth,
  createLatestGuard,
  dailySummary,
  describeSeries,
  donutSegments,
  linePoints,
  pathFrom,
  stackedEvolution,
  statusShareSeries,
  statusShares,
} from "./analytics-charts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    const msg = `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`;
    console.log(msg);
    failures.push(msg);
  }
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

console.log("\n[donutSegments]");
{
  const { total, segments } = donutSegments([
    { name: "Completed", count: 3 },
    { name: "Cancelled", count: 1 },
  ]);
  check("total", total, 4);
  check("shares", segments.map((s) => s.percentage), [75, 25]);
  check("first arc starts at the top", near(segments[0].dashOffset, DONUT_CIRCUMFERENCE), true);
  check(
    "second arc starts where the first ended",
    near(segments[1].dashOffset, DONUT_CIRCUMFERENCE - 0.75 * DONUT_CIRCUMFERENCE),
    true,
  );
  check("arc length", segments[1].dashArray.split(" ").map((n) => Math.round(Number(n))), [
    Math.round(0.25 * DONUT_CIRCUMFERENCE),
    Math.round(0.75 * DONUT_CIRCUMFERENCE),
  ]);
  check("nothing booked draws empty arcs", donutSegments([{ name: "Pending", count: 0 }]).segments[0].percentage, 0);
}

console.log("\n[statusShares]");
{
  const { total, share } = statusShares([
    { name: "Completed", count: 2 },
    { name: "Cancelled", count: 1 },
    { name: "Pending", count: 1 },
  ]);
  check("total", total, 4);
  check("completed", share("Completed"), 50);
  check("absent status is 0", share("No Show"), 0);
  check("no appointments: unmeasured", statusShares([]).share("Completed"), null);
}

console.log("\n[stackedEvolution]");
{
  const columns = stackedEvolution([
    { period: "2026-09", Completed: 6, Cancelled: 2, "No Show": 2 },
    { period: "2026-10", Completed: 5, Cancelled: 0, "No Show": 0 },
  ]);
  check("totals", columns.map((c) => c.total), [10, 5]);
  check("tallest month fills the column", columns[0].segments.map((s) => s.height), [60, 20, 20]);
  check("segments stack bottom up", columns[0].segments.map((s) => s.bottom), [0, 60, 80]);
  check("smaller month scales to the tallest", columns[1].segments[0].height, 50);
  check("empty months do not divide by 0", stackedEvolution([{ period: "2026-10", Completed: 0, Cancelled: 0, "No Show": 0 }])[0].segments[0].height, 0);
}

console.log("\n[statusShareSeries]");
check(
  "share of one status per month",
  statusShareSeries(
    [
      { period: "2026-09", Completed: 3, Cancelled: 1, "No Show": 0 },
      { period: "2026-10", Completed: 0, Cancelled: 0, "No Show": 0 },
    ],
    "Cancelled",
  ),
  [
    { period: "2026-09", count: 1, percentage: 25 },
    { period: "2026-10", count: 0, percentage: 0 },
  ],
);

console.log("\n[barWidth]");
check("half", barWidth(50, 100), 50);
check("max is full", barWidth(100, 100), 100);
check("zero max", barWidth(5, 0), 0);
check("negative value", barWidth(-5, 10), 0);

console.log("\n[linePoints / pathFrom]");
check("no days, no line", linePoints([], 300, 100), []);
check("one day is a flat line", linePoints([5], 300, 100), [
  { x: 0, y: 0 },
  { x: 300, y: 0 },
]);
check("all zero sits on the baseline", linePoints([0, 0], 300, 100), [
  { x: 0, y: 100 },
  { x: 300, y: 100 },
]);
check("scaled to the max", linePoints([0, 50, 100], 300, 100), [
  { x: 0, y: 100 },
  { x: 150, y: 50 },
  { x: 300, y: 0 },
]);
check("path", pathFrom([{ x: 0, y: 100 }, { x: 150.123, y: 50 }]), "M0,100 L150.12,50");

console.log("\n[dailySummary]");
{
  const days = [
    { date: "2026-10-01", appointments: 2, revenue: 5000 },
    { date: "2026-10-02", appointments: 0, revenue: 0 },
    { date: "2026-10-03", appointments: 3, revenue: 4000 },
  ];
  const revenue = dailySummary(days, "revenue");
  check("revenue total", revenue.total, 9000);
  check("best revenue day", revenue.best?.date, "2026-10-01");
  check("busiest day by appointments", dailySummary(days, "appointments").best?.date, "2026-10-03");
  check("active days", revenue.activeDays, 2);
  check("nothing booked: no best day", dailySummary([days[1]], "revenue").best, null);
}

console.log("\n[describeSeries]");
check(
  "label: value pairs",
  describeSeries([{ m: "oct", v: 1 }, { m: "nov", v: 2 }], (r) => r.m, (r) => `${r.v} €`),
  "oct: 1 €; nov: 2 €",
);

console.log("\n[createLatestGuard]");
{
  const guard = createLatestGuard();
  const first = guard.begin();
  const second = guard.begin();
  check("an older request is stale", guard.isLatest(first), false);
  check("the newest request applies", guard.isLatest(second), true);
  guard.cancel();
  check("cancel drops the request in flight", guard.isLatest(second), false);
}

console.log("\n[analytics page layout]");
{
  // The page was one 1.5k-line component; it is now split in components.
  const root = path.resolve(__dirname, "..");
  const page = fs.readFileSync(path.join(root, "app/dashboard/analytics/page.tsx"), "utf8");
  check("page.tsx stays small", page.split("\n").length < 300, true);
  for (const lang of ["es", "en"]) {
    const messages = JSON.parse(fs.readFileSync(path.join(root, `messages/${lang}.json`), "utf8"));
    for (const key of ["top_services_revenue", "daily_evolution", "paid_of_total", "view_by_location"]) {
      check(`${lang}: analytics.${key}`, typeof messages.analytics[key], "string");
    }
  }
}

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All analytics-charts tests passed.");
}
