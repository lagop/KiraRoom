import { PaymentsController } from "./payments.controller";
import { AddOnsAdminController } from "./controllers/addons.controller";
import {
  AppointmentChargeDto,
  CancelSubscriptionDto,
  CreatePaymentBodyDto,
  SubscriptionPlanDto,
  UpdateLocationCountDto,
  UpdatePaymentStatusDto,
  WalletAmountDto,
} from "./dto/payment-bodies.dto";
import { GrantAddOnDto } from "./dto/addon.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

const uuid = (first: number) => `${first}f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60`;

describe("payments bodies", () => {
  it("are validated classes, not inline types", () => {
    const P = PaymentsController;
    expect(bodyMetatype(P, "createPayment")).toBe(CreatePaymentBodyDto);
    expect(bodyMetatype(P, "updatePaymentStatus")).toBe(UpdatePaymentStatusDto);
    expect(bodyMetatype(P, "createCheckout")).toBe(SubscriptionPlanDto);
    expect(bodyMetatype(P, "changePlan")).toBe(SubscriptionPlanDto);
    expect(bodyMetatype(P, "cancelSubscription")).toBe(CancelSubscriptionDto);
    expect(bodyMetatype(P, "updateLocationCount")).toBe(UpdateLocationCountDto);
    expect(bodyMetatype(P, "depositWallet")).toBe(WalletAmountDto);
    expect(bodyMetatype(P, "withdrawWallet")).toBe(WalletAmountDto);
    expect(bodyMetatype(P, "processDeposit")).toBe(AppointmentChargeDto);
    expect(bodyMetatype(P, "collectBalance")).toBe(AppointmentChargeDto);
    expect(bodyMetatype(AddOnsAdminController, "grant")).toBe(GrantAddOnDto);
  });

  it("a wallet deposit is positive cents; the payments page's euros * 100 passes", async () => {
    const parse = bodyParser(PaymentsController, "depositWallet");
    expect(await parse({ amount: 10.1 * 100 })).toEqual({ amount: 10.1 * 100 });
    await expect(parse({ amount: -5000 })).rejects.toBeDefined();
    await expect(parse({ amount: 0 })).rejects.toBeDefined();
    await expect(parse({ amount: "lots" })).rejects.toBeDefined();
  });

  it("the controller rounds a wallet amount to whole cents", async () => {
    const wallet = { addFunds: jest.fn(async () => ({})) };
    const c = new PaymentsController(null as any, null as any, wallet as any, null as any, null as any, null as any);
    await c.depositWallet({ user: { tenantId: "t1" } }, uuid(1), Object.assign(new WalletAmountDto(), { amount: 10.1 * 100 }));
    expect(wallet.addFunds).toHaveBeenCalledWith("t1", uuid(1), 1010, undefined);
  });

  it("a status is one of the four; a payment's type and method are the enums", async () => {
    await expect(bodyParser(PaymentsController, "updatePaymentStatus")({ status: "stolen" })).rejects.toBeDefined();
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
