/**
 * WhatsApp campaigns page: what each state says. A campaign waiting for
 * Meta's review must never read as sent, a rejected one says why, and the
 * typing checks match the server's (whatsapp/campaigns/campaign-template.ts).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/whatsapp-campaign.spec.ts
 */
import {
  CAMPAIGN_FOOTER,
  bodyProblem,
  campaignActions,
  campaignLabel,
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
check("sending: only cancel", sending.cancel && !sending.edit && !sending.remove);

console.log(`\n=== Summary ===\nPass: ${pass}, Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✓ All whatsapp-campaign tests passed.");
