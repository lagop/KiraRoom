import * as fs from "fs";
import * as path from "path";
import {
  AI_PACK_MESSAGES,
  aiConversationsApprox,
  formatCountEs,
  PLAN_AI_CONVERSATIONS,
  PLAN_FEATURES,
  PLAN_IDS,
  PLAN_MAX_PROFESSIONALS,
  PLAN_PRICES,
} from "@kira/shared";
import { PLAN_MATRIX, SubscriptionsService } from "./services/subscriptions.service";

/**
 * L4: the plan catalogue must agree with itself everywhere.
 *
 * It did not. The matrix was declared in four places that each called
 * themselves the single source of truth, and prices in a fifth: the shared
 * package said 29 / 59 / 119 while the billed catalogue and the marketing
 * site said 49 / 79 / 149 -- and the SaaS console computed MRR from the
 * stale copy. The TypeScript sides now import from @kira/shared, so the
 * compiler keeps them honest. The marketing site is JSON and cannot, so
 * this spec is what catches drift there.
 */
const marketingMatrixPath = path.resolve(
  __dirname,
  "../../../../marketing/src/data/planMatrix.json",
);
const marketingAddonsPath = path.resolve(
  __dirname,
  "../../../../marketing/src/data/addons.json",
);
const marketingPricingPagePath = path.resolve(
  __dirname,
  "../../../../marketing/src/pages/pricing.astro",
);

type MarketingPlan = { id: string; price: number; period: string; bullets: string[] };
const marketingPlans = (): MarketingPlan[] =>
  (JSON.parse(fs.readFileSync(marketingMatrixPath, "utf8")) as { plans: MarketingPlan[] }).plans;

describe("plan catalogue consistency", () => {
  it("the backend matrix matches the shared matrix for every plan", () => {
    for (const plan of PLAN_IDS) {
      expect([...PLAN_MATRIX[plan]].sort()).toEqual([...PLAN_FEATURES[plan]].sort());
    }
  });

  it("the billed catalogue prices match the shared prices", () => {
    // No Stripe key in the stub config, so the constructor leaves the Stripe
    // client disabled and never touches the network.
    const registry = new SubscriptionsService(
      {} as any,
      { get: () => undefined } as any,
      { client: () => null, current: () => ({ taxEnabled: false }) } as any,
    ).plans;

    for (const plan of PLAN_IDS) {
      // Catalogue prices are in cents.
      expect(registry[plan].price).toBe(PLAN_PRICES[plan] * 100);
      expect(registry[plan].maxProfessionals).toBe(PLAN_MAX_PROFESSIONALS[plan]);
      expect(registry[plan].aiConversationsPerMonth).toBe(
        PLAN_AI_CONVERSATIONS[plan],
      );
    }
  });

  it("the marketing site advertises the same prices", () => {
    const raw = fs.readFileSync(marketingMatrixPath, "utf8");
    const parsed = JSON.parse(raw) as {
      plans: Array<{ id: string; price: number }>;
    };
    for (const plan of parsed.plans) {
      if (!(PLAN_IDS as readonly string[]).includes(plan.id)) continue;
      expect(plan.price).toBe(PLAN_PRICES[plan.id as (typeof PLAN_IDS)[number]]);
    }
  });

  it("the marketing site lists every plan exactly once", () => {
    const parsed = JSON.parse(fs.readFileSync(marketingMatrixPath, "utf8")) as {
      plans: Array<{ id: string }>;
    };
    expect(parsed.plans.map((p) => p.id).sort()).toEqual([...PLAN_IDS].sort());
  });

  // B2 (settings audit 2026-11-02): /pricing advertised 29 / 59 / 119 EUR
  // and the home promised unlimited AI on Pro plus a 24 EUR "IA Expansion"
  // add-on, while the panel charges 49 / 79 / 149 EUR, Pro has 2,000 AI
  // messages and the AI pack is 1,000 messages for 19 EUR.
  it("the marketing site states each plan's AI cap, and never unlimited AI", () => {
    for (const plan of marketingPlans()) {
      const id = plan.id as (typeof PLAN_IDS)[number];
      const cap = PLAN_AI_CONVERSATIONS[id];
      const ai = plan.bullets.filter((b) => /IA/.test(b));
      expect(ai.some((b) => b.includes(`${formatCountEs(cap)} mensajes al mes`))).toBe(true);
      expect(ai.some((b) => b.includes(`unas ${formatCountEs(aiConversationsApprox(cap))} conversaciones`))).toBe(true);
      expect(ai.some((b) => /ilimitad/i.test(b))).toBe(false);
    }
  });

  it("the marketing site's professionals limits and per-location price match the plans", () => {
    for (const plan of marketingPlans()) {
      const id = plan.id as (typeof PLAN_IDS)[number];
      const max = PLAN_MAX_PROFESSIONALS[id];
      const text = plan.bullets.join(" | ");
      if (max !== null) expect(text).toContain(`Hasta ${max} profesionales`);
      expect(plan.period).toBe(id === "empresa" ? "month_per_location" : "month");
    }
  });

  it("the marketing add-ons are the ones sold, with the AI pack at its real size", () => {
    const { items } = JSON.parse(fs.readFileSync(marketingAddonsPath, "utf8")) as {
      items: Array<{ key: string; name: string; price: number; tagline: string }>;
    };
    const keys = items.map((a) => a.key);
    // Retired (ai_expansion) or withheld (web_domain) add-ons are not sold.
    expect(keys).not.toContain("ai_expansion");
    expect(keys).not.toContain("web_domain");
    const pack = items.find((a) => a.key === "ai_messages_1000");
    expect(pack).toBeDefined();
    expect(pack!.name).toContain(formatCountEs(AI_PACK_MESSAGES));
    expect(pack!.price).toBe(19);
    expect(pack!.tagline).toContain(`unas ${formatCountEs(aiConversationsApprox(AI_PACK_MESSAGES))} conversaciones`);
  });

  it("the /pricing page reads its prices from the same data, with none of its own", () => {
    const page = fs.readFileSync(marketingPricingPagePath, "utf8");
    expect(page).toContain('from "../data/planMatrix.json"');
    expect(page).not.toMatch(/\bprice:\s*\d/);
    expect(page).not.toMatch(/\b(29|59|119)\s*€/);
  });
});
