/**
 * Onboarding wizard hours and the checklist's visibility.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/onboarding-wizard.spec.ts
 */
import {
  checklistStartsOpen,
  onboardingSettled,
  pendingChecklistSteps,
  showChecklistRestore,
  wizardHoursToSend,
  type OnboardingStateLike,
} from "./onboarding-wizard";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

const week = [{ day: "monday", openTime: "09:00", closeTime: "19:00" }];

console.log("wizardHoursToSend (I5)");
check("saved hours, untouched: nothing is sent", wizardHoursToSend(week, false, true), undefined);
check("saved hours, changed: the new week is sent", wizardHoursToSend(week, true, true), week);
check("no saved hours: the week is sent even untouched", wizardHoursToSend(week, false, false), week);
check("a week with no open day sends nothing", wizardHoursToSend([], true, false), undefined);

const defs = [
  { key: "workspace_business", group: "linear_required" },
  { key: "branding", group: "checklist_optional" },
  { key: "reminders_enabled", group: "checklist_optional" },
];
const base: OnboardingStateLike = {
  currentStep: 1,
  checklistDismissed: false,
  finishedAt: "2026-11-01T10:00:00.000Z",
  steps: { workspace_business: { status: "done" } },
  defs,
};

console.log("checklist state (I13, I26)");
check("two optional steps pending", pendingChecklistSteps(base), 2);
check(
  "skipped and done steps are not pending",
  pendingChecklistSteps({ ...base, steps: { branding: { status: "skipped" }, reminders_enabled: { status: "done" } } }),
  0,
);
check("finished with pending steps open: not settled", onboardingSettled(base), false);
check("finished and checklist closed: settled", onboardingSettled({ ...base, checklistDismissed: true }), true);
check(
  "finished and nothing pending: settled",
  onboardingSettled({ ...base, steps: { branding: { status: "done" }, reminders_enabled: { status: "skipped" } } }),
  true,
);
check("wizard not finished: never settled", onboardingSettled({ ...base, finishedAt: null, checklistDismissed: true }), false);
check("no data yet: not settled", onboardingSettled(null), false);

check("opens on the home the first time", checklistStartsOpen("/dashboard", false), true);
check("stays folded on the home once folded", checklistStartsOpen("/dashboard", true), false);
check("starts folded elsewhere", checklistStartsOpen("/dashboard/pos", false), false);

check("restore shown when closed with steps pending", showChecklistRestore({ ...base, checklistDismissed: true }), true);
check(
  "no restore when nothing is pending",
  showChecklistRestore({ ...base, checklistDismissed: true, steps: { branding: { status: "done" }, reminders_enabled: { status: "done" } } }),
  false,
);
check("no restore while the checklist is open", showChecklistRestore(base), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
