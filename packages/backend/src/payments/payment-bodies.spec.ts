import { PaymentsController } from "./payments.controller";
import { AddOnsAdminController } from "./controllers/addons.controller";
import {
  CancelSubscriptionDto,
  CreatePaymentBodyDto,
  RefundPaymentDto,
  SubscriptionPlanDto,
  UpdateLocationCountDto,
  WalletDepositDto,
  WalletWithdrawDto,
} from "./dto/payment-bodies.dto";
import { GrantAddOnDto } from "./dto/addon.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

const uuid = (first: number) => `${first}f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60`;

describe("payments bodies", () => {
  it("are validated classes, not inline types", () => {
    const P = PaymentsController;
    expect(bodyMetatype(P, "createPayment")).toBe(CreatePaymentBodyDto);
    expect(bodyMetatype(P, "createCheckout")).toBe(SubscriptionPlanDto);
    expect(bodyMetatype(P, "changePlan")).toBe(SubscriptionPlanDto);
    expect(bodyMetatype(P, "cancelSubscription")).toBe(CancelSubscriptionDto);
    expect(bodyMetatype(P, "updateLocationCount")).toBe(UpdateLocationCountDto);
    expect(bodyMetatype(P, "depositWallet")).toBe(WalletDepositDto);
    expect(bodyMetatype(P, "withdrawWallet")).toBe(WalletWithdrawDto);
    expect(bodyMetatype(P, "refundPayment")).toBe(RefundPaymentDto);
    expect(bodyMetatype(AddOnsAdminController, "grant")).toBe(GrantAddOnDto);
  });

  it("a wallet top-up is positive cents and how she paid; the payments page's euros * 100 passes", async () => {
    const parse = bodyParser(PaymentsController, "depositWallet");
    expect(await parse({ amount: 10.1 * 100, method: "cash" })).toEqual({ amount: 10.1 * 100, method: "cash" });
    for (const method of ["card", "bizum", "bank_transfer"]) {
      expect(await parse({ amount: 1000, method })).toEqual({ amount: 1000, method });
    }
    await expect(parse({ amount: 1000 })).rejects.toBeDefined();
    // Money she hands over: not another wallet, a gift card or points.
    for (const method of ["wallet", "gift_card", "loyalty_points", "crypto"]) {
      await expect(parse({ amount: 1000, method })).rejects.toBeDefined();
    }
    await expect(parse({ amount: -5000, method: "cash" })).rejects.toBeDefined();
    await expect(parse({ amount: 0, method: "cash" })).rejects.toBeDefined();
    await expect(parse({ amount: "lots", method: "cash" })).rejects.toBeDefined();
  });

  it("a wallet withdrawal is positive cents and how it is handed back", async () => {
    const parse = bodyParser(PaymentsController, "withdrawWallet");
    for (const method of ["cash", "card", "bizum", "bank_transfer"]) {
      expect(await parse({ amount: 1000, method })).toEqual({ amount: 1000, method });
    }
    await expect(parse({ amount: 1000 })).rejects.toBeDefined();
    for (const method of ["wallet", "gift_card", "loyalty_points"]) {
      await expect(parse({ amount: 1000, method })).rejects.toBeDefined();
    }
    await expect(parse({ amount: 0, method: "cash" })).rejects.toBeDefined();
  });

  it("the controller rounds a withdrawal to whole cents and passes the tender and who handed it back", async () => {
    const wallet = { withdraw: jest.fn(async () => ({})), assertClientOfSalon: jest.fn(async () => undefined) };
    const c = new PaymentsController(null as any, null as any, wallet as any, null as any, null as any, null as any);
    await c.withdrawWallet(
      { user: { tenantId: "t1", id: "u1", role: "admin" } },
      uuid(1),
      Object.assign(new WalletWithdrawDto(), { amount: 10.1 * 100, method: "cash" as const, description: "Se va de la ciudad" }),
    );
    expect(wallet.withdraw).toHaveBeenCalledWith("t1", uuid(1), 1010, "cash", { id: "u1", role: "admin" }, "Se va de la ciudad");
  });

  it("the controller rounds a top-up to whole cents and passes the tender and who took it", async () => {
    const wallet = { topUp: jest.fn(async () => ({})), assertClientOfSalon: jest.fn(async () => undefined) };
    const c = new PaymentsController(null as any, null as any, wallet as any, null as any, null as any, null as any);
    await c.depositWallet(
      { user: { tenantId: "t1", id: "u1", role: "owner" } },
      uuid(1),
      Object.assign(new WalletDepositDto(), { amount: 10.1 * 100, method: "bizum" as const }),
    );
    expect(wallet.topUp).toHaveBeenCalledWith("t1", uuid(1), 1010, "bizum", { id: "u1", role: "owner" }, undefined);
  });

  it("a refund: optional whole cents, a reason that is not blank", async () => {
    const parse = bodyParser(PaymentsController, "refundPayment");
    expect(await parse({ amount: 1500, reason: "Error al cobrar" })).toEqual({ amount: 1500, reason: "Error al cobrar" });
    expect(await parse({ reason: "Todo" })).toEqual({ reason: "Todo" });
    await expect(parse({ amount: 1500 })).rejects.toBeDefined();
    await expect(parse({ amount: 1500, reason: "   " })).rejects.toBeDefined();
    await expect(parse({ amount: 0, reason: "x" })).rejects.toBeDefined();
    await expect(parse({ amount: 12.5, reason: "x" })).rejects.toBeDefined();
  });

  it("a payment's type and method are the enums", async () => {
    const create = bodyParser(PaymentsController, "createPayment");
    const body = { amount: 2500, clientId: uuid(1), method: "cash", type: "service" };
    expect(await create({ ...body, status: "paid", tenantId: uuid(2) })).toEqual(body);
    await expect(create({ ...body, method: "crypto" })).rejects.toBeDefined();
    await expect(create({ ...body, amount: 25.5 })).rejects.toBeDefined();
  });

  it("subscription bodies: a plan key, a boolean, a whole location count", async () => {
    expect(await bodyParser(PaymentsController, "changePlan")({ plan: "pro" })).toEqual({ plan: "pro" });
    await expect(bodyParser(PaymentsController, "changePlan")({ plan: { toString: 1 } })).rejects.toBeDefined();
    expect(await bodyParser(PaymentsController, "cancelSubscription")({})).toEqual({});
    await expect(bodyParser(PaymentsController, "cancelSubscription")({ immediately: "yes" })).rejects.toBeDefined();
    await expect(bodyParser(PaymentsController, "updateLocationCount")({ locationCount: 0 })).rejects.toBeDefined();
  });

  it("an add-on grant answers a bad body with a 400, not a ZodError", async () => {
    const parse = bodyParser(AddOnsAdminController, "grant");
    expect(await parse({ addOnKey: "ai_pack", durationDays: 30 })).toEqual({ addOnKey: "ai_pack", durationDays: 30 });
    await expect(parse({ addOnKey: "ai_pack", durationDays: 400 })).rejects.toMatchObject({ status: 400 });
  });
});
