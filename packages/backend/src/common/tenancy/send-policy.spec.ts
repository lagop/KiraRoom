/**
 * Audit 8 D5 (owner's decision 2026-11-04): what a salon still sends while
 * read-only (trial ended, cancelled, suspended) or blocked from the console.
 * Reminders of appointments already booked go on while read-only; marketing
 * campaigns, re-engagement, rebooking reminders and review requests stop;
 * a blocked salon sends nothing.
 *
 * The second part reads every scheduled sender's source and checks it filters
 * its salons with the right rule, so a sender changed back to a bare
 * `deletedAt: null` fails here.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  MARKETING_SENDS_TENANT_WHERE,
  REMINDER_SENDS_TENANT_WHERE,
  canSendMarketing,
  canSendReminders,
} from "./send-policy";

const BLOCKED = new Date("2026-11-04T00:00:00Z");

describe("the send policy", () => {
  it.each([
    ["active", true, true],
    ["trialing", true, true],
    ["past_due", true, true],
    ["cancelled", true, false],
    ["suspended", true, false],
  ])("%s: reminders %s, marketing %s", (status, reminders, marketing) => {
    const t = { subscriptionStatus: status, deletedAt: null, blockedAt: null };
    expect(canSendReminders(t)).toBe(reminders);
    expect(canSendMarketing(t)).toBe(marketing);
  });

  it("a blocked salon sends nothing, whatever its status", () => {
    for (const status of ["active", "trialing", "cancelled"]) {
      expect(canSendReminders({ subscriptionStatus: status, blockedAt: BLOCKED })).toBe(false);
      expect(canSendMarketing({ subscriptionStatus: status, blockedAt: BLOCKED })).toBe(false);
    }
  });

  it("a deleted salon sends nothing", () => {
    expect(canSendReminders({ subscriptionStatus: "cancelled", deletedAt: BLOCKED })).toBe(false);
    expect(canSendMarketing({ subscriptionStatus: "active", deletedAt: BLOCKED })).toBe(false);
    expect(canSendReminders(null)).toBe(false);
  });

  it("the where clauses say the same", () => {
    expect(REMINDER_SENDS_TENANT_WHERE).toEqual({ deletedAt: null, blockedAt: null });
    expect(MARKETING_SENDS_TENANT_WHERE).toEqual({
      deletedAt: null,
      blockedAt: null,
      subscriptionStatus: { notIn: ["cancelled", "suspended"] },
    });
  });
});

describe("every scheduled sender uses it", () => {
  const src = (path: string) => readFileSync(join(__dirname, "..", "..", path), "utf8");
  const SENDERS: Array<[string, string, "REMINDER" | "MARKETING", number]> = [
    ["appointment reminders", "notifications/notifications.scheduler.ts", "REMINDER", 1],
    ["email campaigns (start and batches)", "email-campaigns/email-campaign-sender.service.ts", "MARKETING", 2],
    ["re-engagement", "email-campaigns/email-campaigns.scheduler.ts", "MARKETING", 1],
    ["rebooking reminders", "rebooking/rebooking-dispatcher.service.ts", "MARKETING", 1],
    ["review requests", "reviews/reviews.service.ts", "MARKETING", 1],
    ["WhatsApp campaigns (start and batches)", "whatsapp/campaigns/whatsapp-campaigns.service.ts", "MARKETING", 2],
  ];

  it.each(SENDERS)("%s filters with the %s rule", (_name, path, rule, uses) => {
    const code = src(path);
    const name = `${rule}_SENDS_TENANT_WHERE`;
    expect(code).toContain(`from "../`);
    expect((code.match(new RegExp(`tenant: ${name}`, "g")) ?? []).length).toBeGreaterThanOrEqual(uses);
    // Marketing never goes out on the reminder rule.
    if (rule === "MARKETING") expect(code).not.toContain("REMINDER_SENDS_TENANT_WHERE");
  });

  it("the onboarding reminder to the owner skips blocked salons", () => {
    expect(src("onboarding/onboarding-nudge.service.ts")).toMatch(/blockedAt: null/);
  });
});
