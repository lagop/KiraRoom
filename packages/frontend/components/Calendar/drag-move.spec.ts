/**
 * Dropping an appointment on the calendar.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only components/Calendar/drag-move.spec.ts
 */
import { DRAG_START, PX_PER_QUARTER, droppedOnProfessional, minutesFromDrag, moveErrorText, planMove, serviceOnlyEffect, serviceOnlyText } from "./drag-move";

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

check("one 24px row is 15 minutes", minutesFromDrag(24) === 15 && minutesFromDrag(-48) === -30);
check("a small wobble is no move", minutesFromDrag(8) === 0);

check("a click is not a drag: the mouse must move first", DRAG_START.mouse.distance > 0);
check(
  "but any drag long enough to change the time starts one",
  DRAG_START.mouse.distance < PX_PER_QUARTER / 2 && minutesFromDrag(PX_PER_QUARTER / 2) === 15,
);
check("on a tablet a tap opens it: dragging needs a press and hold", DRAG_START.touch.delay >= 200);
check("and a finger may wobble a little while holding", DRAG_START.touch.tolerance > 0);

check(
  "the column's professional, from the drop data",
  droppedOnProfessional({ id: "p2-14", data: { current: { professionalId: "p2" } } }, "p1") === "p2",
);
check("or from the column id", droppedOnProfessional({ id: "professional-column-p3", data: { current: null } }, "p1") === "p3");
check("dropped outside: stays with the same professional", droppedOnProfessional(null, "p1") === "p1");

const base = { start: "2026-10-28T09:00:00.000Z", end: "2026-10-28T10:00:00.000Z", professionalId: "p1" };
check("same column, same time: nothing to save", planMove({ ...base, newProfessionalId: "p1", minutesDelta: 0, isStaff: false }).kind === "none");

const later = planMove({ ...base, newProfessionalId: "p1", minutesDelta: 30, isStaff: false });
check(
  "30 minutes later keeps the length",
  later.kind === "move" && later.start.toISOString() === "2026-10-28T09:30:00.000Z" && later.end.toISOString() === "2026-10-28T10:30:00.000Z",
  later,
);

const toColleague = planMove({ ...base, newProfessionalId: "p2", minutesDelta: 0, isStaff: false });
check("the owner may move it to a colleague's column", toColleague.kind === "move" && toColleague.professionalId === "p2");

const staffToColleague = planMove({ ...base, newProfessionalId: "p2", minutesDelta: 0, isStaff: true });
check(
  "a professional may not: refused before asking the server",
  staffToColleague.kind === "refuse" && /tu agenda/.test(staffToColleague.message),
  staffToColleague,
);
check("a professional may move within their own column", planMove({ ...base, newProfessionalId: "p1", minutesDelta: 15, isStaff: true }).kind === "move");

check(
  "the server's reason is shown",
  moveErrorText(new Error("Ana ya tiene una cita con Lucía Pérez a las 10:00.")) === "Ana ya tiene una cita con Lucía Pérez a las 10:00.",
);
check("a network failure gets a plain message", /No se ha podido mover/.test(moveErrorText(new Error("Failed to fetch"))));
check("so does anything without a message", /No se ha podido mover/.test(moveErrorText(null)));

// A visit: cut with Ana 10:00-10:30, colour with Bea 10:30-11:30 (Madrid).
const visit = [
  { id: "cut", serviceName: "Corte", start: "2026-11-02T09:00:00.000Z", end: "2026-11-02T09:30:00.000Z" },
  { id: "colour", serviceName: "Color", start: "2026-11-02T09:30:00.000Z", end: "2026-11-02T10:30:00.000Z" },
];
const earlier = serviceOnlyEffect(visit, "cut", -45);
check(
  "moving only the cut 45 min earlier: she waits 45 min between cut and colour",
  earlier.kind === "wait" && earlier.minutes === 45 && earlier.before === "Corte" && earlier.after === "Color",
  earlier,
);
check("and the dialog says so", serviceOnlyText(earlier) === "La clienta esperará 45 min entre Corte y Color.");
const laterOnly = serviceOnlyEffect(visit, "cut", 15);
check("moving only the cut 15 min later: she would be in two places", laterOnly.kind === "two-places" && laterOnly.with === "Color", laterOnly);
check("which the dialog refuses", /No se puede/.test(serviceOnlyText(laterOnly)));
check(
  "a parallel service may overlap by design",
  serviceOnlyEffect([visit[0], { ...visit[1], isParallel: true }], "cut", 15).kind !== "two-places",
);
check(
  "closing an existing gap is no extra wait",
  serviceOnlyEffect([visit[0], { ...visit[1], start: "2026-11-02T10:00:00.000Z", end: "2026-11-02T11:00:00.000Z" }], "cut", 30).kind === "same",
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
