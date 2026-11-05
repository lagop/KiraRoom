/**
 * Onboarding wizard hours and the checklist's visibility.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/onboarding-wizard.spec.ts
 */
import {
  checklistStartsOpen,
  onboardingSettled,
  pendingChecklistSteps,
  salonHoursFromProfessional,
  customServiceProblem,
  showChecklistRestore,
  showLinearOverlay,
  todayIn,
  wizardHoursToSend,
  wizardOutcome,
  type OnboardingStateLike,
} from "./onboarding-wizard";
import { defaultSchedule } from "./weekly-schedule";

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

// O3: no overlay while read-only or impersonating.
const linear = { finishedAt: null, currentStep: 1, linearSteps: 3, readOnly: false, impersonating: false };
check("overlay shown mid-way", showLinearOverlay(linear), true);
check("no overlay once finished", showLinearOverlay({ ...linear, finishedAt: "2026-11-01" }), false);
check("no overlay while read-only", showLinearOverlay({ ...linear, readOnly: true }), false);
check("no overlay while impersonating", showLinearOverlay({ ...linear, impersonating: true }), false);

// O12: today on the salon's clock.
check("today in Madrid just after midnight", todayIn("Europe/Madrid", new Date("2026-11-04T23:30:00Z")), "2026-11-05");
check("today in Canarias at the same moment", todayIn("Atlantic/Canary", new Date("2026-11-04T23:30:00Z")), "2026-11-04");

// O14: custom services checked before sending.
check("custom service fine", customServiceProblem({ name: "Mechas", durationMinutes: 90, price: 60 }), null);
check("empty row ignored", customServiceProblem({ name: " ", durationMinutes: 0, price: 0 }), null);
check(
  "duration 0 refused in Spanish",
  customServiceProblem({ name: "Mechas", durationMinutes: 0, price: 10 }),
  "«Mechas»: la duración tiene que ser de al menos 5 minutos.",
);
check("negative price refused", customServiceProblem({ name: "Mechas", durationMinutes: 30, price: -1 }), "«Mechas»: el precio no puede ser negativo.");

// O4: the closing screen says what was saved.
const none = { hasServices: false, hasStaff: false, hasWorkingHours: false };
const nothing = wizardOutcome({ saved: { services: 0, hours: false, appointment: false }, skipped: { appointment: "no_service" } }, none);
check("nothing saved is not 'listo'", nothing.title, "No se ha guardado nada nuevo");
check("the skipped booking is said", /no se ha creado/.test(nothing.warning ?? ""), true);
const all = wizardOutcome(
  { saved: { services: 2, hours: true, appointment: true }, skipped: { appointment: null } },
  { ...none, hasStaff: true },
);
check("ready when services, staff and hours exist", all.readyForBookings, true);
check("lists what was saved", all.lines.length, 3);
const noStaff = wizardOutcome({ saved: { services: 1, hours: true, appointment: false }, skipped: { appointment: "no_staff" } }, none);
check("not ready without a professional", noStaff.title, "Configuración guardada");

// D10: the salon's hours proposed from the professional's.
const pro = defaultSchedule();
const fromPro = salonHoursFromProfessional(pro);
check("salon hours copy the professional's week", fromPro, pro);
fromPro.monday.shifts[0].end = "14:00";
check("a copy: editing it leaves the professional's", pro.monday.shifts[0].end, "19:00");
const noWeek = salonHoursFromProfessional(null);
check("no professional week: Monday to Saturday open", [noWeek.monday.works, noWeek.saturday.works, noWeek.sunday.works], [true, true, false]);
check("no professional week: 09:00 to 20:00", noWeek.saturday.shifts, [{ start: "09:00", end: "20:00" }]);
const closed = defaultSchedule();
for (const k of Object.keys(closed) as Array<keyof typeof closed>) closed[k] = { works: false, shifts: [] };
check("a week with no working day falls back too", salonHoursFromProfessional(closed).friday.shifts, [{ start: "09:00", end: "20:00" }]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
