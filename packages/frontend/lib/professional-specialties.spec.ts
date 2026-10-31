/**
 * The professional edit page's specialty: shown as stored, required only when
 * there is one, and sent only when changed.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/professional-specialties.spec.ts
 *
 * Professionals created by onboarding or the new-professional form have no
 * specialty or a free-text one, and the edit page refused to save them until
 * one from its list was picked.
 */
import {
  currentSpecialty,
  specialtiesForSave,
  specialtyIsRequired,
  specialtyLabelKey,
  specialtyOptions,
} from "./professional-specialties";

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

console.log("what is stored");
{
  check("none", currentSpecialty([]), "");
  check("not a list", currentSpecialty(null), "");
  check("blank entries skipped", currentSpecialty(["", "  ", "Barber"]), "Barber");
  check("free text kept, trimmed", currentSpecialty([" Estilista senior "]), "Estilista senior");
}

console.log("labels");
{
  check("a listed value has a key", specialtyLabelKey("Hair Stylist"), "professionals.specialtyOptions.hairStylist");
  check("free text has none", specialtyLabelKey("Estilista senior"), null);
}

console.log("options");
{
  const listed = specialtyOptions("Barber");
  check("a listed value adds nothing", listed.length, 7);
  const none = specialtyOptions("");
  check("no specialty adds nothing", none.length, 7);
  const free = specialtyOptions("Estilista senior");
  check("free text is offered first, shown as it is", free[0], { value: "Estilista senior", labelKey: null });
  check("and the list follows", free.length, 8);
}

console.log("required");
{
  check("no specialty: can be saved without one", specialtyIsRequired(""), false);
  check("free text: required (it is preselected)", specialtyIsRequired("Estilista senior"), true);
  check("a listed one: not cleared by mistake", specialtyIsRequired("Barber"), true);
}

console.log("what saving sends");
{
  check("unchanged: nothing, so every stored specialty is kept", specialtiesForSave("Barber", "Barber"), undefined);
  check("still none: nothing", specialtiesForSave("", ""), undefined);
  check("free text unchanged: nothing", specialtiesForSave("Estilista senior", "Estilista senior"), undefined);
  check("picked one: that one", specialtiesForSave("", "Esthetician"), ["Esthetician"]);
  check("changed: the new one", specialtiesForSave("Estilista senior", "Barber"), ["Barber"]);
  check("cleared: none", specialtiesForSave("Barber", ""), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
