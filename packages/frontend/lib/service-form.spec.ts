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

console.log("online payment when booking");
const priced = { ...EMPTY_SERVICE_FORM, name: "Tinte", price: "60" };
check("no señal, no prepayment: nothing asked", (() => {
  const r = formToPayload(priced);
  return r.ok && r.payload.depositRequired === false && r.payload.depositAmount === null && r.payload.depositPercentage === null && r.payload.allowPrepay === false;
})());
check("a fixed señal in euros (comma or point)", (() => {
  const r = formToPayload({ ...priced, paymentKind: "fixed", depositValue: "12,50" });
  return r.ok && r.payload.depositRequired && r.payload.depositAmount === 12.5 && r.payload.depositPercentage === null;
})());
check("a percentage señal", (() => {
  const r = formToPayload({ ...priced, paymentKind: "percent", depositValue: "30" });
  return r.ok && r.payload.depositRequired && r.payload.depositPercentage === 30 && r.payload.depositAmount === null;
})());
check("prepayment alone", (() => {
  const r = formToPayload({ ...priced, allowPrepay: true });
  return r.ok && !r.payload.depositRequired && r.payload.allowPrepay === true;
})());
check("the señal needs a value", (() => {
  const r = formToPayload({ ...priced, paymentKind: "fixed", depositValue: "" });
  return !r.ok && r.error === "deposit_invalid";
})());
check("zero, negative and three-decimal euros are refused", ["0", "-5", "5.555", "abc"].every((v) => !formToPayload({ ...priced, paymentKind: "fixed", depositValue: v }).ok));
check("a percentage is a whole number from 1 to 100", ["0", "101", "12.5", ""].every((v) => !formToPayload({ ...priced, paymentKind: "percent", depositValue: v }).ok) && formToPayload({ ...priced, paymentKind: "percent", depositValue: "100" }).ok);
check("a señal above the price is refused", (() => {
  const r = formToPayload({ ...priced, paymentKind: "fixed", depositValue: "80" });
  return !r.ok && r.error === "deposit_above_price";
})());
check("a service under 0,50 € cannot ask for money online", (() => {
  const r = formToPayload({ ...EMPTY_SERVICE_FORM, name: "X", price: "0.3", allowPrepay: true });
  return !r.ok && r.error === "online_price_low";
})());
check("a free service with nothing online is still fine", formToPayload({ ...EMPTY_SERVICE_FORM, name: "X", price: "0" }).ok);
check("a stored fixed señal fills the form", (() => {
  const f = serviceToForm({ name: "T", category: "hair", duration: 30, price: "60.00", isActive: true, depositRequired: true, depositAmount: "15.00", depositPercentage: null, allowPrepay: true });
  return f.paymentKind === "fixed" && f.depositValue === "15" && f.allowPrepay === true;
})());
check("a stored percentage señal fills the form", (() => {
  const f = serviceToForm({ name: "T", category: "hair", duration: 30, price: "60.00", isActive: true, depositRequired: true, depositAmount: null, depositPercentage: "25.00" });
  return f.paymentKind === "percent" && f.depositValue === "25";
})());
check("settings left on a service that no longer asks for a señal are not shown", (() => {
  const f = serviceToForm({ name: "T", category: "hair", duration: 30, price: "60.00", isActive: true, depositRequired: false, depositAmount: "15.00" });
  return f.paymentKind === "none" && f.depositValue === "";
})());

console.log("every error has a message in both languages");
for (const lang of ["es", "en"]) {
  const raw = fs.readFileSync(path.join(__dirname, "..", "messages", `${lang}.json`), "utf8").replace(/^﻿/, "");
  const services = JSON.parse(raw).services ?? {};
  for (const key of ["name_required", "duration_invalid", "price_invalid", "buffer_invalid", "min_advance_invalid", "max_advance_invalid", "deposit_invalid", "deposit_above_price", "online_price_low", "pay_title", "pay_kind_none", "pay_kind_fixed", "pay_kind_percent", "allow_prepay"]) {
    check(`${lang}: services.${key}`, typeof services[key] === "string" && services[key].length > 0);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
