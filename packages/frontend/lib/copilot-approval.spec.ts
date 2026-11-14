import {
  APPROVAL_STATUS_LABEL,
  approvalCardState,
  approvalResultLines,
  stateFromResolveError,
} from "./copilot-approval";

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, expected: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) {
    console.log(`      expected ${JSON.stringify(expected)}`);
    console.log(`      got      ${JSON.stringify(got)}`);
  }
}

const NOW = Date.parse("2026-11-14T12:00:00Z");
const later = "2026-11-14T12:05:00Z";
const earlier = "2026-11-14T11:55:00Z";

console.log("\n=== the card says what really happened (M9) ===");
check("pending, in time", approvalCardState({ status: "pending", expiresAt: later }, NOW), "pending");
check("pending, past its time", approvalCardState({ status: "pending", expiresAt: earlier }, NOW), "expired");
check(
  "executed stays done after its 5 minutes",
  approvalCardState({ status: "executed", expiresAt: earlier, result: { ok: true } }, NOW),
  "done",
);
check("being carried out", approvalCardState({ status: "approved", expiresAt: later }, NOW), "running");
check(
  "no permission is not a tick",
  approvalCardState({ status: "rejected", expiresAt: earlier, result: { error: "forbidden" } }, NOW),
  "forbidden",
);
check(
  "a tool failure",
  approvalCardState({ status: "rejected", expiresAt: earlier, result: { error: "tool_failure", message: "x" } }, NOW),
  "failed",
);
check("cancelled by her", approvalCardState({ status: "rejected", expiresAt: earlier }, NOW), "cancelled");
check("expired", approvalCardState({ status: "expired", expiresAt: earlier }, NOW), "expired");

console.log("\n=== the result in words ===");
check(
  "the coupon code is shown",
  approvalResultLines({ ok: true, code: "AB12CD", validUntil: "2026-12-01" }),
  ["Código: AB12CD (válido hasta el 1/12/2026)"],
);
check("the tool's message", approvalResultLines({ message: "Avisadas 2 clientas." }), ["Avisadas 2 clientas."]);
check("nothing to say", approvalResultLines(null), []);

console.log("\n=== an action already resolved elsewhere ===");
check("already executed", stateFromResolveError("approval_not_pending:executed"), "done");
check("expired", stateFromResolveError("approval_expired"), "expired");
check("410", stateFromResolveError("", 410), "expired");
check("anything else is an error", stateFromResolveError("Network error"), null);

console.log("\n=== statuses in Spanish (B11) ===");
check("no English status left", Object.values(APPROVAL_STATUS_LABEL).every((l) => !/executed|rejected|expired/.test(l)), true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
