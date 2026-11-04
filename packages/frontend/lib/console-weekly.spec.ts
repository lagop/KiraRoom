/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/console-weekly.spec.ts
 *
 * "Esta semana" (audit 8 D12) and the salons' takings out of the console
 * home and platform Analytics (D10).
 */

import * as fs from "fs";
import * as path from "path";
import { weeklyAllClear, weeklyCounts, weeklyDate, WeeklyDigest } from "./console-weekly";

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

const empty: WeeklyDigest = {
  generatedAt: "2026-11-09T07:00:00.000Z",
  week: "2026-W46",
  pastDue: [],
  trialsEnding: [],
  deletionRequests: [],
  retention: { enabled: false, items: [] },
  aiSpend: { period: "2026-11", totalUsd: 3.5, unpricedModels: [], salons: [] },
  onboardingStuck: [],
  openBugReports: { count: 0, latest: [] },
};

console.log("\n[weeklyCounts / weeklyAllClear]");
check("nothing to do, AI spend alone does not count", weeklyAllClear(empty), true);
check("all gray when empty", weeklyCounts(empty).map((c) => c.tone), ["gray", "gray", "gray", "gray", "gray", "gray", "gray"]);
check("AI spend in dollars", weeklyCounts(empty).find((c) => c.anchor === "ai")?.value, "3.50 $");

const busy: WeeklyDigest = {
  ...empty,
  pastDue: [{ id: "a", name: "A", paymentFailedAt: null, gracePeriodEndsAt: null }],
  retention: {
    enabled: false,
    items: [{ id: "r", name: "R", kind: "warn", anonymizeOn: "2026-11-14T00:00:00.000Z", dueNow: true }],
  },
  openBugReports: { count: 2, latest: [] },
};
const tones = Object.fromEntries(weeklyCounts(busy).map((c) => [c.anchor, c.tone]));
check("not all clear", weeklyAllClear(busy), false);
check("a failed payment is red", tones["past-due"], "red");
check("retention while off (dry run) is amber, not red", tones.retention, "amber");
check(
  "retention due tonight with the flag on is red",
  Object.fromEntries(weeklyCounts({ ...busy, retention: { ...busy.retention, enabled: true } }).map((c) => [c.anchor, c.tone])).retention,
  "red",
);
check("open bugs are amber", tones.bugs, "amber");

console.log("\n[weeklyDate]");
check("Madrid date", weeklyDate("2026-11-08T23:30:00.000Z").replace(/\./g, ""), "9 nov");
check("no date", weeklyDate(null), "—");

console.log("\n[pages]");
const root = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
for (const p of ["app/saas/page.tsx", "app/saas/analytics/page.tsx"]) {
  check(`${p}: no platform-wide salon takings (D10)`, /salonTakings|salon_takings/.test(read(p)), false);
}
check("tenant analytics still shows the salon's takings", /salonTakings/.test(read("app/saas/tenants/[id]/analytics/page.tsx")), true);
check("home shows the weekly block", /<WeeklySummary\s*\/>/.test(read("app/saas/page.tsx")), true);
check("sidebar links to /saas/weekly", /href: "\/saas\/weekly"/.test(read("app/saas/components/sidebar.tsx")), true);

console.log("\n[messages]");
const es = JSON.parse(read("messages/es.json"));
const en = JSON.parse(read("messages/en.json"));
check("same weekly keys in es and en", Object.keys(es.saas.weekly).sort(), Object.keys(en.saas.weekly).sort());
check("Spanish nav label", es.saas.nav.weekly, "Esta semana");
for (const c of weeklyCounts(empty)) check(`es has ${c.labelKey}`, typeof es.saas.weekly[c.labelKey], "string");

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All console-weekly tests passed.");
}
