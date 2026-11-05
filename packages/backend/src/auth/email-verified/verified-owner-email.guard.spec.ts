import { ForbiddenException } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { VerifiedOwnerEmailGuard } from "./verified-owner-email.guard";
import { EMAIL_NOT_VERIFIED_CODE } from "./owner-email-verified";
import { EmailCampaignsController } from "../../email-campaigns/email-campaigns.controller";
import { WhatsAppCampaignsController } from "../../whatsapp/campaigns/whatsapp-campaigns.controller";
import { NotificationsController } from "../../notifications/notifications.controller";
import { PaymentsController } from "../../payments/payments.controller";

/** D1: campaigns, mass sends and Stripe wait for the owner's confirmed email. */
describe("VerifiedOwnerEmailGuard", () => {
  const ctx = (user: unknown) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as never;

  function guard(verifiedOwners: number) {
    const count = jest.fn().mockResolvedValue(verifiedOwners);
    return { guard: new VerifiedOwnerEmailGuard({ user: { count } } as never), count };
  }

  it("lets a salon with a confirmed owner through", async () => {
    const { guard: g, count } = guard(1);
    await expect(g.canActivate(ctx({ tenantId: "t1" }))).resolves.toBe(true);
    expect(count).toHaveBeenCalledWith({ where: { tenantId: "t1", role: "owner", isEmailVerified: true } });
  });

  it("refuses with EMAIL_NOT_VERIFIED and a Spanish message until then", async () => {
    const { guard: g } = guard(0);
    const err = await g.canActivate(ctx({ tenantId: "t1" })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    const body = (err as ForbiddenException).getResponse() as { code: string; message: string };
    expect(body.code).toBe(EMAIL_NOT_VERIFIED_CODE);
    expect(body.message).toMatch(/Confirma el email/);
  });

  it("leaves requests without a salon to the auth guards", async () => {
    const { guard: g, count } = guard(0);
    await expect(g.canActivate(ctx(undefined))).resolves.toBe(true);
    expect(count).not.toHaveBeenCalled();
  });

  it("is on every route that sends to many clients or connects Stripe", () => {
    const routes: Array<[object, string[]]> = [
      [EmailCampaignsController.prototype, ["scheduleCampaign", "sendCampaign", "sendToAll", "retryFailed", "broadcast", "activateCampaign"]],
      [WhatsAppCampaignsController.prototype, ["submit", "resume"]],
      [NotificationsController.prototype, ["sendBulkToClients"]],
      [PaymentsController.prototype, ["updateStripeSettings"]],
    ];
    for (const [proto, names] of routes) {
      for (const name of names) {
        const guards = Reflect.getMetadata(GUARDS_METADATA, (proto as Record<string, unknown>)[name]) ?? [];
        expect({ name, guarded: guards.includes(VerifiedOwnerEmailGuard) }).toEqual({ name, guarded: true });
      }
    }
  });
});
