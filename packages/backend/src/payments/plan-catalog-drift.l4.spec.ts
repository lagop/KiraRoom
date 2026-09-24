import * as fs from "fs";
import * as path from "path";
import {
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
});
