/**
 * The till's ticket and tenders (lib/pos-cart.ts): lines keyed by what they
 * sell, the change, mixed payments with the remainder filled in, and the
 * server's tender rules said before charging.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/pos-cart.spec.ts
 */
import {
  addLine,
  addTender,
  changeCents,
  euros,
  fillRemainder,
  giftCardsForServer,
  itemsForServer,
  lineKey,
  newSaleId,
  parseEurosInput,
  remainingCents,
  removeLine,
  setProfessional,
  setQuantity,
  tenderProblem,
  tendersForServer,
  addTenderRow,
  refillRows,
  tendersOfRows,
  type CartLine,
  type Tender,
  type TenderRow,
} from "./pos-cart";

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

const corte = { kind: "service" as const, serviceId: "s1", name: "Corte", unitCents: 4840 };
const visita = { kind: "appointment" as const, serviceId: "s1", appointmentId: "a1", name: "Corte (Ana)", unitCents: 2840 };
const champu = { kind: "product" as const, productId: "p1", name: "Champú", unitCents: 1210 };

console.log("lines keyed by what they sell");
{
  let cart: CartLine[] = [];
  cart = addLine(cart, visita);
  cart = addLine(cart, corte);
  cart = addLine(cart, corte);
  cart = addLine(cart, champu);
  check("the appointment and the same service sold again are two lines", cart.length === 3, cart.map((l) => l.key));
  check("a second unit of the service adds to its line", cart.find((l) => l.kind === "service")!.quantity === 2);
  check("an appointment is charged once", addLine(cart, visita).find((l) => l.kind === "appointment")!.quantity === 1);

  const more = setQuantity(cart, lineKey(corte), 3);
  check("+/- changes only that line", more.find((l) => l.kind === "service")!.quantity === 3 && more.find((l) => l.kind === "appointment")!.quantity === 1);
  check("an appointment's quantity does not change", setQuantity(cart, lineKey(visita), 4).find((l) => l.kind === "appointment")!.quantity === 1);
  const gone = removeLine(cart, lineKey(corte));
  check("× removes only that line (the appointment stays)", gone.length === 2 && gone.some((l) => l.kind === "appointment"));
  check("0 units removes the line", setQuantity(cart, lineKey(champu), 0).length === 2);

  const byPro = setProfessional(cart, lineKey(corte), "pro-2");
  check("naming who did it re-keys the line", byPro.some((l) => l.key === "svc:s1:pro-2" && l.quantity === 2) && !byPro.some((l) => l.key === "svc:s1:"));
  const merged = setProfessional(addLine(byPro, corte), "svc:s1:", "pro-2");
  check("two lines of the same professional merge", merged.filter((l) => l.kind === "service").length === 1 && merged.find((l) => l.kind === "service")!.quantity === 3);

  check(
    "the server gets what is sold, never a price",
    same(itemsForServer(byPro), [
      { serviceId: "s1", appointmentId: "a1", quantity: 1 },
      { serviceId: "s1", professionalId: "pro-2", quantity: 2 },
      { productId: "p1", quantity: 1 },
    ]),
    itemsForServer(byPro),
  );
  check(
    "gift cards sold: blanks left out",
    same(giftCardsForServer([{ key: "g", amountCents: 5000, recipientName: " Eva ", recipientEmail: "" }]), [{ amountCents: 5000, recipientName: "Eva" }]),
  );
}

console.log("cash: handed over and change");
{
  const due = 4356;
  check("50 € for 43,56 €: 6,44 € back", changeCents([{ method: "cash", amount: 5000 }], due) === 644);
  check("exact: no change", changeCents([{ method: "cash", amount: due }], due) === 0);
  check("short: nothing back, the rest to charge", changeCents([{ method: "cash", amount: 4000 }], due) === 0 && remainingCents([{ method: "cash", amount: 4000 }], due) === 356);
  check("cash over the total is fine", tenderProblem([{ method: "cash", amount: 5000 }], due) === null);
  check("short of the total is not", tenderProblem([{ method: "cash", amount: 4000 }], due) === `Faltan ${euros(356)} por cobrar.`, tenderProblem([{ method: "cash", amount: 4000 }], due));
}

console.log("mixed payments");
{
  const due = 9000;
  let tenders: Tender[] = [{ method: "card", amount: 3000 }];
  tenders = addTender(tenders, due);
  check("a second method takes what is left", same(tenders, [{ method: "card", amount: 3000 }, { method: "cash", amount: 6000 }]), tenders);
  check("and is not the same method again", tenders[1].method === "cash");
  const refilled = fillRemainder([{ method: "card", amount: 5000 }, { method: "bizum", amount: 1 }], due);
  check("changing one fills the other with the rest", refilled[1].amount === 4000);
  check("never below zero", fillRemainder([{ method: "card", amount: 12000 }, { method: "cash", amount: 0 }], due)[1].amount === 0);
  check("card + bizum over the total is refused (only cash gives change)", tenderProblem([{ method: "card", amount: 6000 }, { method: "bizum", amount: 4000 }], due) !== null);
  check("card + cash over the total: the change comes from the cash", tenderProblem([{ method: "card", amount: 6000 }, { method: "cash", amount: 5000 }], due) === null);
  check("a gift card needs its code", tenderProblem([{ method: "gift_card", amount: due }], due) === "Escribe el código de la tarjeta regalo.");
  check(
    "sent: empty tenders dropped, code trimmed and upper-cased",
    same(tendersForServer([{ method: "gift_card", amount: 2000, giftCardCode: " regalo-aaaa " }, { method: "cash", amount: 0 }]), [
      { method: "gift_card", amount: 2000, giftCardCode: "REGALO-AAAA" },
    ]),
  );
  check("a free ticket still sends its zero tender", same(tendersForServer([{ method: "cash", amount: 0 }]), [{ method: "cash", amount: 0 }]));
}

console.log("the tender form");
{
  const due = 4356;
  check("one row, nothing typed: exactly what is due", same(tendersOfRows([{ method: "card", amountText: "" }], due), [{ method: "card", amount: due }]));
  check("cash, 50 handed over: 50 sent (the server records 43,56 and 6,44 change)", tendersOfRows([{ method: "cash", amountText: "50" }], due)[0].amount === 5000);
  check("a bad amount is refused before sending", tenderProblem(tendersOfRows([{ method: "cash", amountText: "abc" }], due), due) !== null);
  let rows: TenderRow[] = [{ method: "card", amountText: "" }];
  rows = addTenderRow(rows, due);
  check("mixed: the first row keeps the whole amount, the new one gets the rest (0)", rows[0].amountText === "43,56" && rows[1].amountText === "0,00" && rows[1].method === "cash", rows);
  rows = refillRows([{ ...rows[0], amountText: "20" }, rows[1]], due, 0);
  check("typing 20 on the card fills the cash with 23,56", rows[1].amountText === "23,56", rows);
  check("and that pays it exactly", tenderProblem(tendersOfRows(rows, due), due) === null);
  const typedLast = refillRows(rows, due, 1);
  check("typing in the last row leaves the others alone", typedLast === rows);
}

console.log("amounts typed and the sale id");
{
  check("12,50 → 1250", parseEurosInput("12,50") === 1250);
  check("20 → 2000", parseEurosInput("20") === 2000);
  check("20 € → 2000", parseEurosInput("20 €") === 2000);
  check("12.345 is not a price", parseEurosInput("12.345") === null);
  check("letters are not", parseEurosInput("doce") === null);
  const a = newSaleId();
  const b = newSaleId();
  check("a sale id is a UUID, new each time", /^[0-9a-f-]{36}$/.test(a) && a !== b, [a, b]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
