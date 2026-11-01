/**
 * Points as the panel shows them (lib/loyalty-points.ts): the expiry period
 * and its rule, and negative balances.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/loyalty-points.spec.ts
 */
import {
  EXPIRY_DAY_OPTIONS,
  balanceClass,
  expiryMonths,
  expiryOptions,
  expiryRuleText,
  isNegativeBalance,
} from "./loyalty-points";

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

console.log("expiry");
{
  check("365 days are 12 months", expiryMonths(365) === 12);
  check("180 days are 6 months", expiryMonths(180) === 6);
  check("45 days are no whole months", expiryMonths(45) === null);
  check("no period: never", expiryMonths(null) === null);
  check(
    "the rule reads like the receipt's",
    expiryRuleText(365) === "Tus puntos caducan si pasan 12 meses sin visitas",
    expiryRuleText(365),
  );
  check("45 days read in days", expiryRuleText(45) === "Tus puntos caducan si pasan 45 días sin visitas");
  check("points that never expire have no rule", expiryRuleText(null) === null);
  check("12 months is offered, and so is «No caducan»", EXPIRY_DAY_OPTIONS.includes(365) && EXPIRY_DAY_OPTIONS.includes(null));
  check("a standard period keeps the standard options", expiryOptions(365) === EXPIRY_DAY_OPTIONS);
  const own = expiryOptions(400);
  check("a salon's own period is offered too, in order, «No caducan» last", own.includes(400) && own[own.length - 1] === null && own.indexOf(400) === own.indexOf(540) - 1, own);
}

console.log("negative balance");
{
  check("below zero is negative", isNegativeBalance(-1));
  check("zero is not", !isNegativeBalance(0));
  check("no member is not", !isNegativeBalance(undefined));
  check("a negative balance is red", balanceClass(-30) === "text-red-700" && balanceClass(30) === "");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
