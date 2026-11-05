/**
 * Gift cards in the panel (lib/gift-cards.ts): status labels (Caducada,
 * Agotada), the default two-year expiry the form starts with, and the plan
 * note read from the shared price list instead of a hard-coded price.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/gift-cards.spec.ts
 */
import { PLAN_PRICES } from "@kira/shared";
import {
  GIFT_CARD_STATUS_LABEL,
  canDeactivate,
  createdEmailNote,
  defaultGiftCardExpiry,
  formatCents,
  formatDay,
  giftCardStatusOf,
  giftCardsPlanNote,
  todayDay,
} from "./gift-cards";

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

const base = { isActive: true, currentBalance: 1000, expiresAt: null as string | null };
const past = new Date(Date.now() - 60_000).toISOString();

check("server status wins", giftCardStatusOf({ ...base, status: "expired" }) === "expired");
check("no balance is Agotada", GIFT_CARD_STATUS_LABEL[giftCardStatusOf({ ...base, currentBalance: 0, isActive: false })] === "Agotada");
check("past expiry is Caducada", GIFT_CARD_STATUS_LABEL[giftCardStatusOf({ ...base, expiresAt: past })] === "Caducada");
check("switched off is Inactiva", GIFT_CARD_STATUS_LABEL[giftCardStatusOf({ ...base, isActive: false })] === "Inactiva");
check("working is Activa", GIFT_CARD_STATUS_LABEL[giftCardStatusOf(base)] === "Activa");

check("only a working card offers Desactivar", canDeactivate("active") && !canDeactivate("inactive") && !canDeactivate("expired") && !canDeactivate("spent"));

check("default expiry is two years from today", defaultGiftCardExpiry(new Date(2026, 10, 1)) === "2028-11-01", defaultGiftCardExpiry(new Date(2026, 10, 1)));
check("today as the date input's min", todayDay(new Date(2026, 0, 5)) === "2026-01-05");
check("days shown dd/mm/yyyy", formatDay("2026-12-31") === "31/12/2026" && formatDay(null) === "—");
check("euros in Spanish", formatCents(2550).replace(/ /g, " ") === "25,50 €", formatCents(2550));

const note = giftCardsPlanNote();
check("plan note reads the shared price", note === `Incluidas desde el plan Pro (${PLAN_PRICES.pro} €/mes).`, note);
check("plan note is not the old wrong 49 €", !note.includes("49 €"), note);

check("email note when sent", createdEmailNote(true, "ana@example.com") === "Enviada por email a ana@example.com.");
check("email note when it failed", (createdEmailNote(false) ?? "").startsWith("No se pudo enviar el email"));
check("no email note when none was asked", createdEmailNote(null) === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
