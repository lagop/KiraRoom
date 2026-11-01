/**
 * WhatsApp campaigns page: what each state says. A campaign waiting for
 * Meta's review must never read as sent, a rejected one says why, and the
 * typing checks match the server's (whatsapp/campaigns/campaign-template.ts).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/whatsapp-campaign.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  BILLING_HREF,
  CAMPAIGN_FOOTER,
  PLAN_NOTICE,
  SENDING_WINDOW,
  bodyProblem,
  isPlanBlocked,
  campaignActions,
  campaignLabel,
  campaignStats,
  insertName,
  previewBody,
  rejectionReason,
} from "./whatsapp-campaign";

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

const base: any = {
  id: "c1",
  tenantId: "t1",
  name: "Otoño",
  body: "Hola {{nombre}}, 20 % hoy.",
  templateId: "",
  templateStatus: "draft",
  templateReason: null,
  status: "draft",
  segmentFilter: {},
  scheduledAt: null,
  submittedAt: null,
  startedAt: null,
  completedAt: null,
  lastError: null,
  createdAt: "2026-10-02T10:00:00Z",
  totalRecipients: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  optedOut: 0,
};
const fmt = (iso: string) => iso.slice(0, 10);
const label = (over: any) => campaignLabel({ ...base, ...over }, fmt);

console.log("campaignLabel");
check("draft", label({}).text === "Borrador");
check("waiting for Meta is never 'sent'", label({ status: "scheduled", templateStatus: "PENDING" }).text === "En revisión de Meta");
check(
  "waiting for Meta mentions the scheduled time",
  (label({ status: "scheduled", templateStatus: "PENDING", scheduledAt: "2099-01-01T10:00:00Z" }).detail ?? "").includes("2099-01-01"),
);
check("approved, future time: scheduled", label({ status: "scheduled", templateStatus: "APPROVED", scheduledAt: "2099-01-01T10:00:00Z" }).text === "Programada");
check("approved, no time: starts now", label({ status: "scheduled", templateStatus: "APPROVED" }).text === "Aprobada");
const rejected = label({ status: "draft", templateStatus: "REJECTED", templateReason: "INVALID_FORMAT" });
check("rejected says so and why", rejected.text === "Rechazada por Meta" && (rejected.detail ?? "").includes("formato"), rejected);
check("completed", label({ status: "completed" }).text === "Enviada");
check("completed with nobody says why", label({ status: "completed", lastError: "Ningún cliente…" }).detail === "Ningún cliente…");
check("failed shows the error", label({ status: "failed", lastError: "desconectado" }).detail === "desconectado");

console.log("rejectionReason");
check("unknown reason is shown as is", rejectionReason("SOMETHING_NEW") === "SOMETHING_NEW");
check("no reason", rejectionReason(null) === "Meta no ha indicado el motivo");

console.log("previewBody / bodyProblem");
check("preview fills the name", previewBody("Hola {{ nombre }}!") === "Hola Ana!");
check("fine text", bodyProblem("Hola {{nombre}}, vuelve pronto.") === null);
check("empty is not an error yet", bodyProblem("   ") === null);
check("cannot start with the name", (bodyProblem("{{nombre}}, vuelve") ?? "").includes("empezar"));
check("cannot end with the name", (bodyProblem("Vuelve, {{nombre}}") ?? "").includes("terminar"));
check("only {{nombre}}", (bodyProblem("Hola {{apellido}} hoy") ?? "").includes("único"));
check("once", (bodyProblem("Hola {{nombre}} y {{nombre}} hoy") ?? "").includes("una sola vez"));
check("length", (bodyProblem("x".repeat(1025)) ?? "").includes("1024"));
check("footer fits Meta's 60 characters", CAMPAIGN_FOOTER.length <= 60);

console.log("campaignActions");
check("draft: edit and submit", campaignActions(base).edit && campaignActions(base).submit && !campaignActions(base).cancel);
const sending = campaignActions({ ...base, status: "sending" });
check("sending: only cancel", sending.cancel && !sending.edit && !sending.remove && !sending.resume);
const pausedActions = campaignActions({ ...base, status: "paused" });
check("paused: resume (Reanudar), cancel or delete", pausedActions.resume && pausedActions.cancel && pausedActions.remove && !pausedActions.edit);
check("only a paused campaign resumes", !campaignActions({ ...base, status: "completed" }).resume);

console.log("Pro only (whatsapp_marketing)");
const noPlanDraft = campaignActions(base, false);
check("without the plan a draft cannot be edited or sent", !noPlanDraft.edit && !noPlanDraft.submit && noPlanDraft.remove);
const noPlanPaused = campaignActions({ ...base, status: "paused" }, false);
check("without the plan a paused campaign cannot resume, only be cancelled or deleted", !noPlanPaused.resume && noPlanPaused.cancel && noPlanPaused.remove);
check("403 FEATURE_NOT_IN_PLAN is the plan", isPlanBlocked({ status: 403, code: "FEATURE_NOT_IN_PLAN" }));
check("another 403 is not", !isPlanBlocked({ status: 403, code: "SUBSCRIPTION_SUSPENDED" }) && !isPlanBlocked(new Error("x")));
check("the notice names Pro and Empresa and keeps the past campaigns readable", /Pro y Empresa/.test(PLAN_NOTICE) && /anteriores/.test(PLAN_NOTICE));
check("the upgrade link goes to Facturación", BILLING_HREF === "/dashboard/billing");
const plannedPause = label({ status: "paused", lastError: "Tu plan no incluye campañas de WhatsApp" });
check("a campaign paused by the plan says so", plannedPause.detail === "Pausada: Tu plan no incluye campañas de WhatsApp", plannedPause);

console.log("No campaigns on Sundays");
check("the sending window says no Sundays", SENDING_WINDOW.includes("No se envía en domingo") && SENDING_WINDOW.includes("9:00"));
const page = fs.readFileSync(path.join(__dirname, "..", "app/dashboard/marketing/whatsapp/page.tsx"), "utf8");
check("the page shows the sending window", page.includes("SENDING_WINDOW"));
check("the page shows the plan notice with the link to Facturación", page.includes("PLAN_NOTICE") && page.includes("BILLING_HREF"));
check("the page handles 403 FEATURE_NOT_IN_PLAN", page.includes("isPlanBlocked("));

console.log("M9: paused and sent-with-errors labels");
const paused = label({ status: "paused", lastError: "Meta no puede cobrar los mensajes." });
check("paused says so with the reason", paused.text === "Pausada" && paused.detail === "Pausada: Meta no puede cobrar los mensajes.", paused);
check("paused without a stored reason still explains", (label({ status: "paused" }).detail ?? "").startsWith("Pausada: "));
const withErrors = label({ status: "completed", totalRecipients: 10, failed: 3, completedAt: "2026-10-05T10:00:00Z" });
check("some failed: 'Enviada con errores'", withErrors.text === "Enviada con errores" && withErrors.tone === "amber", withErrors);
check("…saying how many", (withErrors.detail ?? "").includes("3 de 10 no se pudieron enviar"), withErrors);
check("one failed: singular", (label({ status: "completed", totalRecipients: 4, failed: 1 }).detail ?? "").includes("1 de 4 no se pudo enviar"));
check("none failed: 'Enviada'", label({ status: "completed", totalRecipients: 10, sent: 10 }).text === "Enviada");

console.log("M10: counts line");
check("nothing before sending", campaignStats({ ...base, status: "scheduled", totalRecipients: 5 }) === null);
const stats = campaignStats({ ...base, status: "paused", totalRecipients: 10, sent: 4, delivered: 3, read: 1, failed: 0, optedOut: 1, pending: 5 });
check("paused: counts and what is still pending", stats === "10 destinatarios · 4 enviados · 3 entregados · 1 leídos · 0 fallidos · 1 bajas · 5 pendientes", stats);
check("completed: counts, no pending", !(campaignStats({ ...base, status: "completed", totalRecipients: 2, sent: 2 }) ?? "").includes("pendientes"));

console.log("B2: insertName");
const mid = insertName("Hola, este mes 20 % en mechas.", 4);
check("inserts at the cursor", mid.body === "Hola {{nombre}}, este mes 20 % en mechas.", mid);
check("cursor goes after the name", mid.cursor === "Hola {{nombre}}".length, mid);
const midWord = insertName("Te esperamos este mes", 12);
check("spaces around the name inside a sentence", midWord.body === "Te esperamos {{nombre}} este mes", midWord);
const atEnd = insertName("Este mes 20 % en mechas.", "Este mes 20 % en mechas.".length);
check("cursor at the end: greets at the start instead", atEnd.body === "Hola {{nombre}}, Este mes 20 % en mechas.", atEnd);
check("…and the result is valid for Meta", bodyProblem(atEnd.body) === null, bodyProblem(atEnd.body));
const trailing = insertName("Vuelve pronto  ", 13);
check("only spaces after the cursor counts as the end", trailing.body.startsWith("Hola {{nombre}}, ") && bodyProblem(trailing.body) === null, trailing);
check("empty message gets the greeting", insertName("", 0).body === "Hola {{nombre}}, ");
check("cursor at the very start greets too", insertName("Vuelve pronto.", 0).body === "Hola {{nombre}}, Vuelve pronto.");
check("an existing 'Hola' is merged, not doubled", insertName("Hola, vuelve pronto.", 20).body === "Hola {{nombre}}, vuelve pronto.");
check("a text that already has the name is left alone", insertName("Hola {{nombre}}, ya", 3).body === "Hola {{nombre}}, ya");
check("never ends with the name", bodyProblem(insertName("Gracias por venir", 17).body) === null);

console.log(`\n=== Summary ===\nPass: ${pass}, Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✓ All whatsapp-campaign tests passed.");
