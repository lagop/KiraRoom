/**
 * Review texts: the headline follows the add-on, the public rules list the
 * reasons, and the panel says who rejected what and why.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/reviews.spec.ts
 */
import * as fs from "fs";
import * as path from "path";
import {
  PUBLISH_CONSENT_TEXT,
  REJECTION_REASONS,
  moderationLine,
  publicReviewRules,
  publicVisibilityNote,
  requestsHeadline,
} from "./reviews";

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

check("four rejection reasons", REJECTION_REASONS.map((r) => r.key).join() === "offensive,personal_data,off_topic,spam");
check("the consent box text", PUBLISH_CONSENT_TEXT === "Pueden mostrar mi opinión en su web con mi nombre e inicial");

check(
  "'después de cada cita' only when the requests are on",
  requestsHeadline({ addOnActive: true, autoRequestsEnabled: true }).startsWith("Después de cada cita") &&
    !requestsHeadline({ addOnActive: false, autoRequestsEnabled: true }).startsWith("Después de cada cita") &&
    !requestsHeadline({ addOnActive: true, autoRequestsEnabled: false }).startsWith("Después de cada cita") &&
    !requestsHeadline(null).startsWith("Después de cada cita"),
);
check(
  "without the add-on it names it",
  requestsHeadline({ addOnActive: false, autoRequestsEnabled: false }).includes("Reseñas tras la cita"),
);
check("no WhatsApp or SMS promise", !/WhatsApp|SMS/.test(requestsHeadline({ addOnActive: true, autoRequestsEnabled: true })));

const rules = publicReviewRules();
check("public rules: all published, positive and negative", /todas las opiniones, positivas y negativas/.test(rules.summary));
check("public rules list the four reasons", rules.reasons.length === 4 && rules.reasons.includes("Datos personales"));

check(
  "declined consent is explained",
  /no dio permiso/i.test(publicVisibilityNote({ status: "published", publishConsent: "declined" }) ?? ""),
);
check("legacy consent shows normally", publicVisibilityNote({ status: "published", publishConsent: "legacy" }) === null);
check("pending: nothing", publicVisibilityNote({ status: "pending", publishConsent: "declined" }) === null);

const line = moderationLine({
  status: "rejected",
  moderationReason: "personal_data",
  moderationReasonLabel: "Datos personales",
  moderatedByName: "Lucía Pérez",
  moderatedAt: "2026-11-03T10:00:00.000Z",
});
check("who, when and why", !!line && line.startsWith("Rechazada por Lucía Pérez el") && line.endsWith(": Datos personales"), line);
check(
  "a legacy rejection is flagged for review",
  /sin motivo \(anterior\)/.test(moderationLine({ status: "rejected", moderationReason: "legacy_unspecified" }) ?? ""),
);
check(
  "auto-published after the grace period says so",
  /automáticamente/.test(moderationLine({ status: "published", moderatedAt: "2026-11-03T10:00:00.000Z" }) ?? ""),
);
check("in moderation: nothing", moderationLine({ status: "moderation" }) === null);

// The pages themselves: same Google button for every score, consent unticked,
// a reason for every rejection, and no WhatsApp/SMS promise in the panel.
const ROOT = path.join(__dirname, "..");
const publicPage = fs.readFileSync(path.join(ROOT, "app/public/r/[token]/page.tsx"), "utf8");
check("the review page no longer branches on a good rating", !/goodRating|rating\s*>=\s*4/.test(publicPage));
check("the consent box starts unticked", /useState\(false\)/.test(publicPage) && publicPage.includes("PUBLISH_CONSENT_TEXT"));
check("the review page names the salon as controller", publicPage.includes("Responsable del tratamiento"));
const panel = fs.readFileSync(path.join(ROOT, "app/dashboard/reviews/page.tsx"), "utf8");
check("the panel rejects only with a reason", /moderateReview\(rejecting\.id, "reject", reason\)/.test(panel));
check("the panel promises no WhatsApp or SMS requests", !/whatsappLabel|channels\.(sms|whatsapp)/.test(panel));
check("the panel says the Place ID wins", panel.includes("se usa el Place ID"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
