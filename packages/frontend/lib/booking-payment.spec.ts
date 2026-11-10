/**
 * Paying online when booking: the choices each combination gives the client,
 * what is sent, what is shown as due, what to do with the answer, and that
 * its texts exist in both languages.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/booking-payment.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  BOOKING_PAYMENT_TEXT,
  ServiceOnlinePayment,
  amountDueNow,
  bookingNeedsPayment,
  effectiveChoice,
  euros,
  paymentOptions,
  paymentReturn,
  paymentToSend,
  safeCheckoutUrl,
} from "./booking-payment";

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
const plain = (s: string) => s.replace(/[  ]/g, " ");

const offer = (over: Partial<ServiceOnlinePayment>): ServiceOnlinePayment => ({
  mode: "none",
  totalCents: 6000,
  depositCents: null,
  depositRequired: false,
  canPayFull: false,
  ...over,
});
const none = offer({});
const optional = offer({ mode: "optional", canPayFull: true });
const deposit = offer({ mode: "deposit", depositCents: 1500, depositRequired: true });
const either = offer({ mode: "deposit_or_full", depositCents: 1500, depositRequired: true, canPayFull: true });

console.log("\n[what each combination offers]");
check("nothing online: no choice at all", paymentOptions(none) === null && paymentOptions(null) === null && paymentOptions(undefined) === null);
check("prepayment alone: optional, pay later or all", (() => {
  const o = paymentOptions(optional)!;
  return !o.required && o.defaultChoice === "later" && o.options.map((x) => x.value).join() === "later,full" && o.options[1].cents === 6000;
})());
check("señal only: required, one option", (() => {
  const o = paymentOptions(deposit)!;
  return o.required && o.options.length === 1 && o.options[0].value === "deposit" && o.options[0].cents === 1500;
})());
check("señal or all: required, the señal first and by default", (() => {
  const o = paymentOptions(either)!;
  return o.required && o.defaultChoice === "deposit" && o.options.map((x) => x.value).join() === "deposit,full";
})());
check("a señal mode without an amount offers nothing (never a free 'required' payment)", paymentOptions(offer({ mode: "deposit" })) === null && paymentOptions(offer({ mode: "deposit_or_full", canPayFull: true })) === null);

console.log("\n[what she picks, what is sent, what is due]");
check("the default applies until she picks", effectiveChoice(either, null) === "deposit" && effectiveChoice(optional, null) === "later");
check("a choice the service does not offer falls back to the default", effectiveChoice(deposit, "full") === "deposit" && effectiveChoice(optional, "deposit") === "later");
check("señal or all: sends what she picked", paymentToSend(either, "full") === "full" && paymentToSend(either, "deposit") === "deposit" && paymentToSend(either, null) === "deposit");
check("señal only: always the señal", paymentToSend(deposit, "full") === "deposit");
check("prepayment alone: sends 'full' only if she chose it; later sends nothing", paymentToSend(optional, "full") === "full" && paymentToSend(optional, "later") === undefined && paymentToSend(optional, null) === undefined);
check("nothing offered: nothing sent", paymentToSend(none, "full") === undefined && paymentToSend(undefined, "deposit") === undefined);
check("due now: the señal, the whole price, or nothing", amountDueNow(either, null) === 1500 && amountDueNow(either, "full") === 6000 && amountDueNow(optional, "later") === null && amountDueNow(none, null) === null);
check("euros are written the Spanish way", plain(euros(1500)) === "15,00 €" && plain(euros(6050)) === "60,50 €", euros(1500));

console.log("\n[the answer to the booking]");
const paymentAnswer = { id: "a1", payment: { required: true, kind: "deposit", amountCents: 1500, currency: "eur", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_1", holdUntil: "2026-11-10T10:36:00.000Z" } };
check("a booking that must be paid is recognised", bookingNeedsPayment(paymentAnswer));
check("an ordinary booking is not", !bookingNeedsPayment({ id: "a1", status: "confirmed" }) && !bookingNeedsPayment(null) && !bookingNeedsPayment(undefined));
check("a payment without a link is not enough", !bookingNeedsPayment({ payment: { required: true } }) && !bookingNeedsPayment({ payment: { required: false, checkoutUrl: "https://checkout.stripe.com/x" } }));

console.log("\n[links]");
check("Stripe's payment page opens", safeCheckoutUrl("https://checkout.stripe.com/c/pay/cs_1") !== null);
check("another site never opens", safeCheckoutUrl("https://evil.example.com/pay") === null);
check("a lookalike host never opens", safeCheckoutUrl("https://stripe.com.evil.example/x") === null);
check("http and javascript: never open", safeCheckoutUrl("http://checkout.stripe.com/x") === null && safeCheckoutUrl("javascript:alert(1)") === null);
check("nothing is nothing", safeCheckoutUrl(null) === null && safeCheckoutUrl("") === null);

console.log("\n[coming back from Stripe]");
check("?pago=ok / cancelado", paymentReturn("?pago=ok") === "ok" && paymentReturn("pago=cancelado") === "cancelado");
check("anything else is a normal visit", paymentReturn("") === null && paymentReturn("?pago=x") === null);

console.log("\n[texts]");
const T = BOOKING_PAYMENT_TEXT;
check("the amounts go into the sentences", T.depositNote("15,00 €").includes("15,00 €") && T.choiceDeposit("15,00 €").includes("15,00 €") && T.choiceFull("60,00 €").includes("60,00 €") && T.payButton("15,00 €").includes("15,00 €"));
check("the hold time shown is the one the server keeps", T.holdNote.includes("30"));
check("nothing is left empty", [T.title, T.optionalNote, T.choiceLater, T.redirecting, T.payFailed, T.holdNote].every((s) => typeof s === "string" && s.length > 0));
check("Spanish accents are written", /señal/.test(T.depositNote("1 €")) && /guardamos el hueco/.test(T.holdNote));
void fs;
void path;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
