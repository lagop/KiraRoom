/**
 * Dropping an appointment on the calendar.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only components/Calendar/drag-move.spec.ts
 */
import { droppedOnProfessional, minutesFromDrag, moveErrorText, planMove } from "./drag-move";

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
