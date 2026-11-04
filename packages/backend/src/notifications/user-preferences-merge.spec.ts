import { NotificationsService } from "./notifications.service";
import { DEFAULT_PREFERENCES } from "./notification-defaults";

/** One toggle in the panel (audit 7 D12) keeps the user's other choices. */
describe("NotificationsService.mergePreferencesForUser", () => {
  function harness(stored: Record<string, any> | null) {
    let row: any = stored ? { userId: "u1", preferences: stored } : null;
    const prisma: any = {
      notificationPreference: {
        findUnique: jest.fn(async () => row),
        upsert: jest.fn(async ({ create, update }: any) => {
          row = { userId: "u1", preferences: row ? update.preferences : create.preferences };
          return row;
        }),
      },
    };
    return { svc: new NotificationsService(prisma, {} as any, {} as any), get: () => row };
  }

  it("merges the type and channel, leaving the rest", async () => {
    const t = harness({ appointment_created: { email: false }, salon_booking_alert: { email: true, inApp: true } });
    await t.svc.mergePreferencesForUser("u1", "t1", { preferences: { salon_booking_alert: { email: false } } });
    expect(t.get().preferences).toEqual({
      appointment_created: { email: false },
      salon_booking_alert: { email: false, inApp: true },
    });
  });

  it("with nothing stored, creates just that choice; non-booleans are dropped", async () => {
    const t = harness(null);
    await t.svc.mergePreferencesForUser("u1", "t1", { preferences: { salon_booking_alert: { email: false, sms: "yes" as any } } });
    expect(t.get().preferences).toEqual({ salon_booking_alert: { email: false } });
  });

  it("the sender reads it: off once turned off, on by default", async () => {
    const t = harness(null);
    expect(await t.svc.shouldSendNotificationForUser("u1", "salon_booking_alert", "email")).toBe(DEFAULT_PREFERENCES.salon_booking_alert.email);
    await t.svc.mergePreferencesForUser("u1", "t1", { preferences: { salon_booking_alert: { email: false } } });
    expect(await t.svc.shouldSendNotificationForUser("u1", "salon_booking_alert", "email")).toBe(false);
  });
});
