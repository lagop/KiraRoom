/**
 * Email campaigns page: which buttons each campaign shows, the schedule on
 * the salon's clock, the picker's exclusion summary and the plan notice.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/email-campaigns.spec.ts
 */
import {
  campaignActions,
  campaignProgress,
  campaignStatusLabel,
  errorMessage,
  exclusionSummary,
  formatSalonDateTime,
  isPlanBlocked,
  optionalText,
  scheduledInstantIso,
  sendConfirmText,
} from "./email-campaigns";

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

const base: any = { status: "draft", campaignType: "newsletter", emailsSent: 0, archivedAt: null, failedCount: 0 };

console.log("status labels");
check("in Spanish", campaignStatusLabel("draft") === "Borrador" && campaignStatusLabel("scheduled") === "Programada");
check("sent and failed", campaignStatusLabel("sent") === "Enviada" && campaignStatusLabel("failed") === "Fallida");
check("unknown shown as is", campaignStatusLabel("weird") === "weird");

console.log("campaignActions");
const draft = campaignActions(base);
check("draft: send, schedule, recipients, edit, delete", draft.sendNow && draft.sendToAll && draft.schedule && draft.recipients && draft.edit && draft.delete);
check("draft: no archive, no unschedule", !draft.archive && !draft.unschedule);

const reDraft = campaignActions({ ...base, campaignType: "reengagement" });
check("re-engagement draft: no one-shot send, schedule or send to all", !reDraft.sendNow && !reDraft.sendToAll && !reDraft.schedule && !reDraft.recipients);
check("re-engagement draft: activate and edit", reDraft.activate && reDraft.edit);
const reActive = campaignActions({ ...base, campaignType: "reengagement", status: "active" });
check("re-engagement active: only deactivate", reActive.deactivate && !reActive.delete && !reActive.archive && !reActive.edit);
check("deactivate only for re-engagement", !campaignActions({ ...base, status: "active" }).deactivate);
const reRan = campaignActions({ ...base, campaignType: "reengagement", emailsSent: 12 });
check("a re-engagement draft that ran is archived, not deleted", reRan.archive && !reRan.delete);

const scheduled = campaignActions({ ...base, status: "scheduled" });
check("scheduled: unschedule, nothing else", scheduled.unschedule && !scheduled.edit && !scheduled.delete && !scheduled.sendNow);

const sending = campaignActions({ ...base, status: "sending", emailsSent: 3 });
check("sending: nothing", Object.values(sending).every((v) => !v));

const sent = campaignActions({ ...base, status: "sent", emailsSent: 30, failedCount: 2 });
check("sent: archive and retry failed, never delete", sent.archive && sent.retryFailed && !sent.delete);
check("sent with nothing failed: no retry", !campaignActions({ ...base, status: "sent", emailsSent: 30 }).retryFailed);
const archived = campaignActions({ ...base, status: "sent", emailsSent: 30, failedCount: 2, archivedAt: "2026-11-01T10:00:00Z" });
check("archived: only unarchive", archived.unarchive && !archived.archive && !archived.retryFailed && !archived.delete);

console.log("optional fields");
check("empty is left out", optionalText("") === undefined && optionalText("   ") === undefined && optionalText(null) === undefined);
check("a value is trimmed", optionalText(" hola@salon.es ") === "hola@salon.es");

console.log("schedule on the salon's clock");
check("10:30 in Madrid in winter is 09:30 UTC", scheduledInstantIso("2026-11-20", "10:30", "Europe/Madrid") === "2026-11-20T09:30:00.000Z");
check("10:30 in Madrid in summer is 08:30 UTC", scheduledInstantIso("2026-07-01", "10:30", "Europe/Madrid") === "2026-07-01T08:30:00.000Z");
check("10:30 in the Canaries is 10:30 UTC in winter", scheduledInstantIso("2026-11-20", "10:30", "Atlantic/Canary") === "2026-11-20T10:30:00.000Z");
const shown = formatSalonDateTime("2026-11-20T09:30:00.000Z", "Europe/Madrid");
check("shown es-ES, salon time", /20 de noviembre de 2026/.test(shown) && /10:30/.test(shown), shown);

console.log("exclusion summary");
check("nobody left out: nothing", exclusionSummary({ no_visit: 0 }) === null);
const summary = exclusionSummary({ no_visit: 8, refused: 1, suppressed: 0, no_email: 3, inactive: 0 });
check(
  "counts and reasons",
  summary === "12 clientas no pueden recibir campañas: 8 no han venido nunca (sin visitas completadas), 1 no quiere recibir promociones, 3 no tienen email.",
  summary,
);
check("one client", exclusionSummary({ refused: 1 }) === "1 clienta no puede recibir campañas: 1 no quiere recibir promociones.");

console.log("confirm text");
check("send names the pending count", sendConfirmText("send", 42).includes("las 42 destinatarias"));
check("send to one", sendConfirmText("send", 1).includes("la destinataria que tiene añadida"));
check("send to all says who", /han venido al menos una vez/.test(sendConfirmText("sendAll", 0)) && /aceptan promociones/.test(sendConfirmText("sendAll", 0)));

console.log("progress");
check("sending", campaignProgress({ status: "sending", emailsSent: 40, totalRecipients: 100, failedCount: 2 }) === "Enviando: 40 de 100, 2 fallidos");
check("sent with failures", campaignProgress({ status: "sent", emailsSent: 98, totalRecipients: 100, failedCount: 2 }) === "2 emails no se pudieron enviar");
check("sent, all fine", campaignProgress({ status: "sent", emailsSent: 100, totalRecipients: 100, failedCount: 0 }) === null);
check("last error wins", campaignProgress({ status: "draft", emailsSent: 0, totalRecipients: 0, lastError: "Llegó la hora" }) === "Llegó la hora");

console.log("plan notice");
const planError = Object.assign(new Error("Feature 'email_marketing' no disponible en tu plan actual."), { status: 403, code: "FEATURE_NOT_IN_PLAN" });
check("plan 403 is recognised", isPlanBlocked(planError));
check("other 403 is not", !isPlanBlocked(Object.assign(new Error("No"), { status: 403 })));
check("plan error reads in Spanish", /Facturación/.test(errorMessage(planError)));
check("server message kept", errorMessage(new Error("La campaña no tiene destinatarias")) === "La campaña no tiene destinatarias");
check("fallback", errorMessage(null) === "Algo ha fallado. Inténtalo de nuevo.");

console.log(`\n=== Summary ===\nPass: ${pass}, Fail: ${fail}`);
if (fail > 0) process.exit(1);
console.log("✓ All email-campaigns tests passed.");
