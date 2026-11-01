/**
 * The cash drawer's close flow in the panel (lib/cash-session.ts): the
 * count by coin and note, what is sent to the server, the difference and
 * its colour, and the till's rule that cash needs the drawer open.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/cash-session.spec.ts
 */
import {
  DENOMINATIONS,
  breakdownForServer,
  countTotalCents,
  denominationLabel,
  discrepancy,
  discrepancyClass,
  discrepancyTone,
  drawerProblem,
  expectedCashOf,
  movementProblem,
  parsePieces,
  topUpProblem,
  WALLET_TOP_UP_METHODS,
} from "./cash-session";
import { parseEurosInput } from "./pos-cart";
import es from "../messages/es.json";
import en from "../messages/en.json";

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
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("counting the drawer by coin and note");
{
  check("every euro coin and note, largest first", DENOMINATIONS[0] === 50000 && DENOMINATIONS[DENOMINATIONS.length - 1] === 1);
  check("labels", denominationLabel(5000) === "50 €" && denominationLabel(200) === "2 €" && denominationLabel(50) === "50 cent");
  check("an empty row is 0 pieces; a bad one is not a number", parsePieces("") === 0 && parsePieces(" 3 ") === 3 && parsePieces("2,5") === null && parsePieces("-1") === null);

  const rows = { 5000: "2", 2000: "1", 200: "3", 10: "", 1: "4" };
  check("adds up the pieces", countTotalCents(rows) === 2 * 5000 + 2000 + 3 * 200 + 4, countTotalCents(rows));
  check("no total while a row is wrong", countTotalCents({ 5000: "dos" }) === null);
  check("the server gets only what is there", same(breakdownForServer(rows), { "5000": 2, "2000": 1, "200": 3, "1": 4 }), breakdownForServer(rows));
  check("nothing counted with the helper: no breakdown sent", breakdownForServer({}) === undefined);
}

console.log("the close: counted against expected");
{
  // Float 100 €, 65 € cash kept, 10 € refunded, 15 € out: 140 € expected.
  const expected = 14_000;
  const typed = parseEurosInput("139,50");
  check("the counted cash typed in euros", typed === 13_950);
  const diff = discrepancy(typed!, expected);
  check("short by 0,50 €", diff === -50 && discrepancyTone(diff) === "short" && discrepancyClass(diff).includes("red"));
  check("square", discrepancyTone(discrepancy(14_000, expected)) === "square" && discrepancyClass(0).includes("green"));
  check("over", discrepancyTone(discrepancy(14_200, expected)) === "over" && discrepancyClass(200).includes("amber"));
  check("an empty drawer may be counted as 0", parseEurosInput("0") === 0);
}

console.log("cash needs the drawer open");
{
  check("closed + cash: refused before charging", drawerProblem([{ method: "cash", amount: 4000 }], false) === "pos.cash_session.err_drawer_closed");
  check(
    "closed + the cash part of a mixed payment: refused",
    drawerProblem([{ method: "card", amount: 2000 }, { method: "cash", amount: 2000 }], false) !== null,
  );
  check("closed + card or Bizum: fine", drawerProblem([{ method: "card", amount: 4000 }, { method: "bizum", amount: 100 }], false) === null);
  check("open + cash: fine", drawerProblem([{ method: "cash", amount: 4000 }], true) === null);
  check("not known yet: the server decides", drawerProblem([{ method: "cash", amount: 4000 }], null) === null);
}

console.log("money in and out");
{
  check("needs an amount", movementProblem(null, "Banco", "out", 10_000) === "pos.cash_session.err_amount");
  check("needs a reason", movementProblem(500, "  ", "in", 0) === "pos.cash_session.err_reason");
  check("cannot take out more than there should be", movementProblem(10_001, "Banco", "out", 10_000) === "pos.cash_session.err_out_too_much");
  check("putting money in has no ceiling", movementProblem(10_001, "Cambio", "in", 0) === null);
  check("blind count (expected unknown): no ceiling either", movementProblem(10_001, "Banco", "out", null) === null);
  check("blind count still needs an amount and a reason", movementProblem(500, " ", "out", null) === "pos.cash_session.err_reason");
}

console.log("blind count: the panel never stands in for the expected cash");
{
  check("owner/admin view: the expected cash", expectedCashOf({ blind: false, expectedCashCents: 14_500 }) === 14_500);
  check("an older full view without the flag is full", expectedCashOf({ expectedCashCents: 900 }) === 900);
  check("staff (blind) view: null, not 0", expectedCashOf({ blind: true }) === null);
  check("blind even if a figure slipped in", expectedCashOf({ blind: true, expectedCashCents: 14_500 }) === null);
  check("no session: null", expectedCashOf(null) === null);
}

console.log("wallet top-ups: how she pays, and cash needs the drawer");
{
  check("the four tenders, cash first", same([...WALLET_TOP_UP_METHODS], ["cash", "card", "bizum", "bank_transfer"]));
  check("a method is required", topUpProblem(null, true) === "payments.top_up_method_required");
  check("cash with the drawer closed is refused", topUpProblem("cash", false) === "payments.top_up_drawer_closed");
  check("cash with the drawer open goes", topUpProblem("cash", true) === null);
  check("drawer state unknown: the server decides", topUpProblem("cash", null) === null);
  for (const m of ["card", "bizum", "bank_transfer"]) check(`${m} goes with the drawer closed`, topUpProblem(m, false) === null);
  for (const k of ["top_up_method_required", "top_up_drawer_closed", "top_up_method"]) {
    check(`payments.${k} in es and en`, typeof (es as any).payments[k] === "string" && typeof (en as any).payments[k] === "string");
  }
}

console.log("texts: Spanish first, English too");
{
  const keys = (o: any) => Object.keys(o?.pos?.cash_session ?? {}).sort();
  const esKeys = keys(es);
  check("es has the drawer's texts", esKeys.length > 20, esKeys.length);
  check("en has the same keys", same(esKeys, keys(en)), esKeys.filter((k) => !keys(en).includes(k)));
  for (const k of ["err_drawer_closed", "err_amount", "err_reason", "err_out_too_much", "blind_hint", "close_intro_blind", "confirm_desc_blind", "closed_toast_blind", "report_blind_title", "your_movements", "wallet_top_ups_cash", "of_which_top_ups"]) {
    check(`${k} is there`, typeof (es as any).pos.cash_session[k] === "string");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
