/**
 * The service drawer's form (lib/service-form.ts).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/service-form.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import { EMPTY_SERVICE_FORM, formToPayload, parseEuros, serviceToForm } from "./service-form";

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

const API_SERVICE = {
  name: "Corte",
  description: null,
  category: "hair" as const,
  duration: 45,
  // As the API returns it: a Decimal column comes back as a string.
  price: "25.00",
  bufferTime: 10,
  isActive: true,
  isOnlineBookable: false,
  requiresApproval: true,
  minAdvanceBooking: 24,
  maxAdvanceBooking: 60,
};

console.log("editing a service sends its price as a number");
{
  const result = formToPayload(serviceToForm(API_SERVICE));
  check("valid without retyping anything", result.ok, result);
  if (result.ok) {
    check("price is the number 25", result.payload.price === 25, result.payload.price);
    check("duration is a number", result.payload.duration === 45);
    check("keeps the online settings", result.payload.isOnlineBookable === false && result.payload.requiresApproval === true);
    check("keeps the booking window", result.payload.minAdvanceBooking === 24 && result.payload.maxAdvanceBooking === 60);
    check("always euros", result.payload.currency === "EUR");
    check("keeps the cleanup time", result.payload.bufferTime === 10, result.payload.bufferTime);
  }
}

console.log("an emptied duration is an error, not 30 minutes");
{
  const result = formToPayload({ ...EMPTY_SERVICE_FORM, name: "Corte", duration: "" });
  check("refused", !result.ok && result.error === "duration_invalid", result);
  check("4 minutes refused", !formToPayload({ ...EMPTY_SERVICE_FORM, name: "X", duration: "4" }).ok);
  check("7.5 minutes refused", !formToPayload({ ...EMPTY_SERVICE_FORM, name: "X", duration: "7.5" }).ok);
  check("601 minutes refused", !formToPayload({ ...EMPTY_SERVICE_FORM, name: "X", duration: "601" }).ok);
  check("5 minutes accepted", formToPayload({ ...EMPTY_SERVICE_FORM, name: "X", duration: "5" }).ok);
}

console.log("cleanup time after the appointment");
check("a new service has none", (() => {
  const r = formToPayload({ ...EMPTY_SERVICE_FORM, name: "X" });
  return r.ok && r.payload.bufferTime === 0;
})());
check("a service without one reads as 0", serviceToForm({ ...API_SERVICE, bufferTime: undefined }).bufferTime === "0");
check("240 accepted", formToPayload({ ...EMPTY_SERVICE_FORM, name: "X", bufferTime: "240" }).ok);
check("241 refused", (() => {
  const r = formToPayload({ ...EMPTY_SERVICE_FORM, name: "X", bufferTime: "241" });
  return !r.ok && r.error === "buffer_invalid";
})());
check("negative, decimal and empty refused", ["-5", "7.5", ""].every(
  (v) => !formToPayload({ ...EMPTY_SERVICE_FORM, name: "X", bufferTime: v }).ok,
));

console.log("prices");
check("comma decimal", parseEuros("25,50") === 25.5);
check("point decimal", parseEuros("25.5") === 25.5);
check("three decimals refused", parseEuros("25.505") === null);
check("negative refused", parseEuros("-1") === null);
check("empty refused", parseEuros("") === null);
check("zero accepted", parseEuros("0") === 0);

console.log("the rest of the form");
check("blank name refused", (() => {
  const r = formToPayload({ ...EMPTY_SERVICE_FORM, name: "   " });
  return !r.ok && r.error === "name_required";
})());
check("name trimmed", (() => {
  const r = formToPayload({ ...EMPTY_SERVICE_FORM, name: "  Corte  " });
  return r.ok && r.payload.name === "Corte";
})());
check("0 days ahead refused", !formToPayload({ ...EMPTY_SERVICE_FORM, name: "X", maxAdvanceBooking: "0" }).ok);
check("0 hours of notice accepted", formToPayload({ ...EMPTY_SERVICE_FORM, name: "X", minAdvanceBooking: "0" }).ok);
check("a new service starts with the backend's defaults", (() => {
  const r = formToPayload({ ...EMPTY_SERVICE_FORM, name: "X" });
  return r.ok && r.payload.duration === 30 && r.payload.minAdvanceBooking === 2 && r.payload.maxAdvanceBooking === 30;
})());

console.log("every error has a message in both languages");
for (const lang of ["es", "en"]) {
  const raw = fs.readFileSync(path.join(__dirname, "..", "messages", `${lang}.json`), "utf8").replace(/^﻿/, "");
  const services = JSON.parse(raw).services ?? {};
  for (const key of ["name_required", "duration_invalid", "price_invalid", "buffer_invalid", "min_advance_invalid", "max_advance_invalid"]) {
    check(`${lang}: services.${key}`, typeof services[key] === "string" && services[key].length > 0);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
