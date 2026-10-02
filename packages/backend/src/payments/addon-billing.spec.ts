import { BadRequestException, ConflictException } from "@nestjs/common";
import { AddOnsService } from "./services/addons.service";
import { SubscriptionsService } from "./services/subscriptions.service";
import { planItemOf, activationFromSubscription } from "./plan-activation";
import { monthlyPlanRevenue } from "../saas/saas.service";

/**
 * Add-ons could not be bought: checkout needed a Stripe `price_` id that no
 * catalogue row had, and the Checkout it opened was on the salon's own
 * Stripe account. Cancelling only flipped our row while Stripe kept
 * billing, and MRR ignored add-ons.
 *
 * Now an add-on is an item of the salon's plan subscription, priced with
 * price_data from the catalogue, added and removed with proration, and
 * activated or deactivated from the subscription's items by the
 * customer.subscription.updated webhook. Only add-ons marked purchasable
 * can be bought: the rest say "Próximamente". Stripe is mocked throughout.
 */

const CATALOG: Record<string, any> = {
  ai_expansion: {
    id: "a-ai",
    key: "ai_expansion",
    name: "IA Expansion",
    description: null,
    monthlyPriceCents: 2400,
    currency: "EUR",
    unlocks: ["virtual_receptionist_advanced"],
    metered: false,
    stripePriceId: null,
    isActive: true,
    purchasable: true,
    sortOrder: 10,
  },
  web_domain: {
    id: "a-web",
    key: "web_domain",
    name: "Dominio personalizado",
    description: null,
    monthlyPriceCents: 1500,
    currency: "EUR",
    unlocks: [],
    metered: false,
    stripePriceId: null,
    isActive: true,
    purchasable: false,
    sortOrder: 60,
  },
};

function subscription(items: any[], extra: any = {}) {
  return {
    id: "sub_plan",
    status: "active",
    current_period_end: 1_900_000_000,
    metadata: { kind: "plan", tenantId: "t1", plan: "esencial" },
    items: {
      data: [
        { id: "si_plan", quantity: 1, metadata: {}, price: { unit_amount: 4900 } },
        ...items,
      ],
    },
    ...extra,
  };
}

function setup(opts: { tenant?: any } = {}) {
  const rows: any[] = [];
  const keyOf = (addOnId: string) => Object.values(CATALOG).find((a) => a.id === addOnId)?.key;
  const prisma: any = {
    addOn: {
      findUnique: async ({ where }: any) => CATALOG[where.key] ?? null,
      findMany: async ({ where }: any) =>
        Object.values(CATALOG).filter((a) => !where?.key || where.key.in.includes(a.key)),
    },
    tenant: {
      findUnique: async () =>
        opts.tenant ?? {
          plan: "esencial",
          subscriptionStatus: "active",
          stripeSubscriptionId: "sub_plan",
        },
      update: async () => ({}),
    },
    user: { findFirst: async () => null },
    tenantAddOn: {
      findUnique: async ({ where }: any) =>
        rows.find(
          (r) => r.tenantId === where.tenantId_addOnId.tenantId && r.addOnId === where.tenantId_addOnId.addOnId,
        ) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const k = where.tenantId_addOnId;
        let row = rows.find((r) => r.tenantId === k.tenantId && r.addOnId === k.addOnId);
        if (row) Object.assign(row, update);
        else {
          row = { id: `row-${rows.length + 1}`, startedAt: new Date(), cancelledAt: null, ...create };
          rows.push(row);
        }
        return row;
      },
      findMany: async ({ where }: any) =>
        rows
          .filter(
            (r) =>
              r.tenantId === where.tenantId &&
              r.stripeSubscriptionId === where.stripeSubscriptionId &&
              r.status !== "cancelled",
          )
          .map((r) => ({ ...r, addOn: { key: keyOf(r.addOnId) } })),
      update: async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data),
      updateMany: async ({ where, data }: any) => {
        const hit = rows.filter(
          (r) =>
            r.tenantId === where.tenantId &&
            (!where.addOnId || r.addOnId === where.addOnId) &&
            (!where.stripeSubscriptionItemId || where.stripeSubscriptionItemId.in.includes(r.stripeSubscriptionItemId)) &&
            r.status !== "cancelled",
        );
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
  };

  // The Stripe API, mocked: the subscription's items live here.
  let live = subscription([]);
  const stripe: any = {
    subscriptions: {
      retrieve: jest.fn(async () => JSON.parse(JSON.stringify(live))),
      update: jest.fn(async (_id: string, params: any) => {
        const deleted = new Set(params.items.filter((i: any) => i.deleted).map((i: any) => i.id));
        live.items.data = live.items.data.filter((i: any) => !deleted.has(i.id));
        return live;
      }),
      cancel: jest.fn(),
    },
    subscriptionItems: {
      create: jest.fn(async (params: any) => {
        const item = {
          id: `si_${params.metadata.addOnKey}`,
          quantity: 1,
          metadata: params.metadata,
          price: { unit_amount: params.price_data.unit_amount },
        };
        live.items.data.push(item);
        return item;
      }),
      retrieve: jest.fn(async (id: string) => ({
        ...live.items.data.find((i: any) => i.id === id),
        subscription: "sub_plan",
      })),
      del: jest.fn(async (id: string) => {
        live.items.data = live.items.data.filter((i: any) => i.id !== id);
        return { id, deleted: true };
      }),
    },
    products: {
      retrieve: jest.fn(async () => {
        throw Object.assign(new Error("No such product"), { statusCode: 404 });
      }),
      create: jest.fn(async (p: any) => ({ id: p.id ?? "prod_new" })),
    },
  };
  const subs = new SubscriptionsService(prisma, { get: () => undefined } as any);
  (subs as any).stripe = stripe;
  (subs as any).isEnabled = true;
  const metrics: any = { counter: () => ({ inc: () => undefined }) };
  const svc = new AddOnsService(prisma, { get: () => undefined } as any, subs, metrics, {} as any);
  return { svc, subs, stripe, prisma, rows, setLive: (s: any) => (live = s), getLive: () => live };
}

describe("buying an add-on", () => {
  it("adds a price_data item to the plan subscription, prorated, and activates it", async () => {
    const { svc, stripe, rows } = setup();

    const row = await svc.purchase("t1", "ai_expansion");

    const params = stripe.subscriptionItems.create.mock.calls[0][0];
    expect(params).toMatchObject({
      subscription: "sub_plan",
      quantity: 1,
      proration_behavior: "create_prorations",
      metadata: { kind: "addon", addOnKey: "ai_expansion", tenantId: "t1" },
      price_data: {
        currency: "eur",
        unit_amount: 2400,
        recurring: { interval: "month" },
        product: "kiraroom_addon_ai_expansion",
      },
    });
    expect(row.status).toBe("active");
    expect(rows[0]).toMatchObject({
      stripeSubscriptionItemId: "si_ai_expansion",
      stripeSubscriptionId: "sub_plan",
      monthlyPriceCents: 2400,
      status: "active",
    });
  });

  it("does not sell an add-on marked Próximamente", async () => {
    const { svc, stripe } = setup();
    await expect(svc.purchase("t1", "web_domain")).rejects.toThrow(ConflictException);
    expect(stripe.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it("needs a paid subscription to add it to (not a trial)", async () => {
    const { svc, stripe } = setup({
      tenant: { plan: "esencial", subscriptionStatus: "trialing", stripeSubscriptionId: null },
    });
    await expect(svc.purchase("t1", "ai_expansion")).rejects.toThrow(BadRequestException);
    expect(stripe.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it("does not sell what the plan already includes", async () => {
    const { svc } = setup({
      tenant: { plan: "pro", subscriptionStatus: "active", stripeSubscriptionId: "sub_plan" },
    });
    await expect(svc.purchase("t1", "ai_expansion")).rejects.toThrow(BadRequestException);
  });

  it("does not add a second item when Stripe already has one (double click)", async () => {
    const { svc, stripe, setLive } = setup();
    setLive(
      subscription([
        { id: "si_ai_expansion", quantity: 1, metadata: { kind: "addon", addOnKey: "ai_expansion" }, price: { unit_amount: 2400 } },
      ]),
    );
    await svc.purchase("t1", "ai_expansion");
    expect(stripe.subscriptionItems.create).not.toHaveBeenCalled();
  });
});

describe("cancelling an add-on", () => {
  it("removes the item from Stripe (prorated) before ending it here", async () => {
    const { svc, stripe, rows } = setup();
    await svc.purchase("t1", "ai_expansion");

    await svc.cancelForTenant("t1", "ai_expansion");

    expect(stripe.subscriptionItems.del).toHaveBeenCalledWith("si_ai_expansion", {
      proration_behavior: "create_prorations",
    });
    expect(rows[0].status).toBe("cancelled");
  });

  it("refuses to remove the plan item", async () => {
    const { subs } = setup();
    await expect(subs.removeAddOnItem({ tenantId: "t1", itemId: "si_plan" })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe("the subscription webhook drives add-on state", () => {
  it("activates an item that appears and cancels one that left", async () => {
    const { svc, rows } = setup();
    await svc.syncFromSubscription(
      subscription([
        { id: "si_ai_expansion", metadata: { kind: "addon", addOnKey: "ai_expansion", tenantId: "t1" }, price: { unit_amount: 2400 } },
      ]) as any,
    );
    expect(rows[0].status).toBe("active");

    await svc.syncFromSubscription(subscription([]) as any);
    expect(rows[0].status).toBe("cancelled");
  });

  it("a failed payment gates the add-on; the subscription ending cancels it", async () => {
    const { svc, rows } = setup();
    const item = { id: "si_ai_expansion", metadata: { kind: "addon", addOnKey: "ai_expansion" }, price: { unit_amount: 2400 } };
    await svc.syncFromSubscription(subscription([item], { status: "past_due" }) as any);
    expect(rows[0].status).toBe("past_due");

    await svc.syncFromSubscription(subscription([item], { status: "canceled" }) as any);
    expect(rows[0].status).toBe("cancelled");
  });
});

describe("plan items next to add-on items", () => {
  const sub: any = subscription([
    { id: "si_ai_expansion", quantity: 1, metadata: { kind: "addon", addOnKey: "ai_expansion" } },
  ]);
  sub.items.data.reverse(); // the add-on first: items[0] is not the plan

  it("the plan item is found by kind, not position", () => {
    expect(planItemOf(sub)?.id).toBe("si_plan");
  });

  it("locations are read off the plan item", () => {
    sub.items.data.find((i: any) => i.id === "si_plan").quantity = 3;
    expect(activationFromSubscription(sub)?.locations).toBe(3);
  });

  it("a plan change drops add-ons the new plan includes", async () => {
    const { subs, stripe, setLive, rows } = setup();
    rows.push({ id: "row-1", tenantId: "t1", addOnId: "a-ai", stripeSubscriptionItemId: "si_ai_expansion", status: "active" });
    setLive(
      subscription([
        { id: "si_ai_expansion", quantity: 1, metadata: { kind: "addon", addOnKey: "ai_expansion" } },
      ]),
    );
    (subs as any).prisma.tenant.findUnique = async () => ({ stripeSubscriptionId: "sub_plan" });

    await subs.changePlan("t1", "pro");

    const items = stripe.subscriptions.update.mock.calls[0][1].items;
    expect(items).toContainEqual({ id: "si_ai_expansion", deleted: true });
    expect(items.find((i: any) => i.id === "si_plan").price_data.unit_amount).toBe(7900);
    expect(rows[0].status).toBe("cancelled");
  });
});

describe("MRR", () => {
  it("adds what each paid add-on bills, in cents, to the plan", () => {
    expect(monthlyPlanRevenue("esencial", 1, [2400, 1200])).toBe(85);
    expect(monthlyPlanRevenue("esencial", 1, [1290])).toBe(61.9);
    expect(monthlyPlanRevenue("empresa", 2, [null, 0])).toBe(298);
  });
});
