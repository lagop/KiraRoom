/**
 * The WhatsApp page's reception test and template submission result.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/whatsapp-reception.spec.ts
 */
import { RECEPTION_TEST_MS, receptionPoll, templateSubmitErrors, type ReceptionTestState } from "./whatsapp-reception";

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

const t0 = Date.UTC(2026, 10, 4, 10, 0, 0);
const waiting: ReceptionTestState = { kind: "waiting", since: new Date(t0 - 60_000).toISOString(), startedAt: t0 };

check("keeps waiting with no event", receptionPoll(waiting, null, t0 + 5_000).kind === "waiting");
check(
  "an event before the test does not count",
  receptionPoll(waiting, new Date(t0 - 10 * 60_000).toISOString(), t0 + 5_000).kind === "waiting",
);
const got = receptionPoll(waiting, new Date(t0 + 20_000).toISOString(), t0 + 25_000);
check("an event after `since` is a success", got.kind === "received", got);
check("gives up after the test time", receptionPoll(waiting, null, t0 + RECEPTION_TEST_MS).kind === "timeout");
check("a finished test stays as it is", receptionPoll({ kind: "timeout" }, new Date(t0).toISOString(), t0).kind === "timeout");

check(
  "Meta's refusals are listed once each",
  JSON.stringify(
    templateSubmitErrors({
      a: "ERROR: El token ha caducado",
      b: "ERROR: El token ha caducado",
      c: "PENDING",
    }),
  ) === JSON.stringify(["El token ha caducado"]),
);
check("no refusals, no errors", templateSubmitErrors({ a: "PENDING", b: "APPROVED" }).length === 0);
check("an empty answer is no error", templateSubmitErrors(null).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
