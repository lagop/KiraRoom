/**
 * The panel menu: who sees what, and which group opens for the current page.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/dashboard-nav.spec.ts
 */

import * as fs from "fs";
import * as path from "path";
import { DASHBOARD_NAV, NavEntry, NavLink, activeGroup, badgesIn, isActive, navFor } from "./dashboard-nav";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`, detail ?? "");
  }
}

const links = (nav: NavEntry[]): NavLink[] => nav.flatMap((e) => (e.kind === "link" ? [e] : e.items));
const ids = (nav: NavEntry[]) => links(nav).map((l) => l.id);

console.log("who sees what");
{
  const owner = ids(navFor("owner"));
  const staff = ids(navFor("staff"));
  const staffOnly = links(DASHBOARD_NAV).filter((l) => l.staffOnly).map((l) => l.id);
  check("the staff-only screens are their security and their own time off", staffOnly.join() === "my-time-off,security-staff", staffOnly);
  check("the owner sees every screen but the staff-only ones", owner.length === links(DASHBOARD_NAV).length - staffOnly.length, owner);
  check("staff ask for their time off; the owner answers the requests", staff.includes("my-time-off") && !staff.includes("time-off-requests") && owner.includes("time-off-requests") && !owner.includes("my-time-off"));
  check("only the owner and managers fetch the pending requests badge", badgesIn(navFor("owner")).join() === "time-off-requests" && badgesIn(navFor("admin")).join() === "time-off-requests" && badgesIn(navFor("staff")).length === 0);
  check("the owner finds the plan and subscription in the menu", owner.includes("billing"));
  check("the website widget is in Ajustes, for managers only", owner.includes("widget") && !staff.includes("widget") && activeGroup(navFor("owner"), "/dashboard/settings/widget") === "settings");
  check("staff keep their daily screens", ["dashboard", "appointments", "clients", "wait-list", "pos", "share"].every((id) => staff.includes(id)), staff);
  check("staff do not see the salon's management screens", !["payments", "professionals", "billing", "analytics", "whatsapp", "invoices"].some((id) => staff.includes(id)), staff);
  check("staff keep their own two-step verification", staff.includes("security-staff"));
  check("staff have no settings group and no empty team group", !navFor("staff").some((e) => e.id === "settings" || e.id === "team"));
  check("before the user is read, the menu is the staff one (matches the server render)", ids(navFor(null)).join() === staff.join());
}

console.log("current page");
{
  const billing = links(DASHBOARD_NAV).find((l) => l.id === "billing")!;
  const general = links(DASHBOARD_NAV).find((l) => l.id === "settings")!;
  const invoices = links(DASHBOARD_NAV).find((l) => l.id === "invoices")!;
  check("the billing page is not active on the invoices page", !isActive(billing, "/dashboard/billing/invoices"));
  check("invoices are active on a new invoice", isActive(invoices, "/dashboard/billing/invoices/new"));
  check("«Generales» only on the settings index", isActive(general, "/dashboard/settings") && !isActive(general, "/dashboard/settings/salon"));
  check("a prefix of another path is not a match", !isActive(invoices, "/dashboard/billing/invoices-old"));

  const nav = navFor("owner");
  check("the billing page opens Ajustes", activeGroup(nav, "/dashboard/billing") === "settings");
  check("a WhatsApp campaign opens Marketing", activeGroup(nav, "/dashboard/marketing/whatsapp/new") === "marketing");
  check("the till opens Caja y ventas", activeGroup(nav, "/dashboard/pos") === "sales");
  check("the till's products open Caja y ventas, for managers only", activeGroup(nav, "/dashboard/pos/products") === "sales" && !ids(navFor("staff")).includes("pos-products") && ids(navFor("owner")).includes("pos-products"));
  check("a top-level page opens no group", activeGroup(nav, "/dashboard/appointments") === null);
  check("the requests page opens Equipo y servicios", activeGroup(nav, "/dashboard/solicitudes-ausencia") === "team");
}

console.log("every link has its translation and its page");
{
  const messages = ["es", "en"].map((lang) => JSON.parse(fs.readFileSync(path.join(__dirname, "../messages", `${lang}.json`), "utf8")));
  const lookup = (m: any, key: string) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), m);
  const keys = [...links(DASHBOARD_NAV).map((l) => l.label), ...DASHBOARD_NAV.filter((e) => e.kind === "group").map((g) => g.label)];
  const missing = keys.flatMap((key) => messages.flatMap((m, i) => (typeof lookup(m, key) === "string" ? [] : [`${["es", "en"][i]}:${key}`])));
  check("labels exist in es.json and en.json", missing.length === 0, missing);

  const pages = links(DASHBOARD_NAV).filter((l) => !fs.existsSync(path.join(__dirname, "../app", l.href, "page.tsx")));
  check("every href is a page in app/", pages.length === 0, pages.map((l) => l.href));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
