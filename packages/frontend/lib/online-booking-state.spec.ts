/**
 * What the panel says about a booking paid online: waiting for her payment,
 * or paid and how much the salon holds.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/online-booking-state.spec.ts
 */
import { holdUntilLabel, isAwaitingOnlinePayment, onlineKindLabel, onlineRefundNotice, paidOnlineCents } from "./online-booking-state";

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

const held = { onlinePaymentKind: "deposit", paymentHoldUntil: "2026-11-10T10:36:00.000Z", depositPaid: false, depositAmount: 1500, totalAmount: 6000, amountPaid: 0 };
const paidDeposit = { onlinePaymentKind: "deposit", paymentHoldUntil: null, depositPaid: true, depositAmount: 1500, totalAmount: 6000, amountPaid: 1500 };
const paidFull = { onlinePaymentKind: "full", paymentHoldUntil: null, depositPaid: false, totalAmount: 6000, amountPaid: 6000 };

console.log("\n[waiting for her payment]");
check("held and unpaid is awaiting", isAwaitingOnlinePayment(held));
check("paid, never held, or nothing at all is not", !isAwaitingOnlinePayment(paidDeposit) && !isAwaitingOnlinePayment({}) && !isAwaitingOnlinePayment(null) && !isAwaitingOnlinePayment(undefined));
check("the hold time is shown as hours and minutes", /^\d{2}:\d{2}$/.test(holdUntilLabel(held) ?? ""), holdUntilLabel(held));
check("no hold, or a bad date, shows nothing", holdUntilLabel(paidDeposit) === null && holdUntilLabel({ paymentHoldUntil: "nope" }) === null);

console.log("\n[what the salon holds]");
check("a paid señal: the señal", paidOnlineCents(paidDeposit) === 1500);
check("a prepaid service: the whole price", paidOnlineCents(paidFull) === 6000);
check("still held: nothing is held yet", paidOnlineCents(held) === 0);
check("never paid online: nothing, even if she paid at the till", paidOnlineCents({ amountPaid: 3000 }) === 0 && paidOnlineCents(null) === 0);
check("never more than was paid (a part was already given back)", paidOnlineCents({ ...paidDeposit, amountPaid: 500 }) === 500);
check("amounts as the API sends them (strings) are read", paidOnlineCents({ ...paidDeposit, depositAmount: "1500", amountPaid: "1500.00" }) === 1500);
check("the kind in words", onlineKindLabel(paidFull) === "el servicio completo" && onlineKindLabel(paidDeposit) === "la señal" && onlineKindLabel({}) === "la señal");

console.log("\n[what a cancellation says about her money]");
check("nothing paid online: no notice", onlineRefundNotice({ id: "a" }) === null && onlineRefundNotice(null) === null && onlineRefundNotice({ onlineRefund: { refundedCents: 0, failed: 0 } }) === null);
check("given back: how much", /15,00/.test(onlineRefundNotice({ onlineRefund: { refundedCents: 1500, failed: 0 } })?.description ?? ""));
check("could not be given back: a warning for the salon to act", onlineRefundNotice({ onlineRefund: { refundedCents: 0, failed: 1 } })?.variant === "destructive");
check("a part given back and a part not: still the warning", onlineRefundNotice({ onlineRefund: { refundedCents: 800, failed: 1 } })?.variant === "destructive");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
