import { NEW_SALON_REBOOKING_SETTINGS, createTenantWithOwner } from "./saas.helpers";
import { ClientCadenceService } from "../rebooking/client-cadence.service";

/** Audit 7 D13: rebooking reminders are on for a new salon; salons from before keep theirs. */
describe("a new salon's rebooking reminders", () => {
  it("are on, 3 days ahead, by email, after 3 visits", async () => {
    const tenantCreate = jest.fn(async (_args: { data: Record<string, unknown> }) => ({ id: "tenant-new" }));
    const tx = {
      tenant: { create: tenantCreate },
      user: { create: jest.fn(async () => ({ id: "user-new", email: "duena@salon.test", role: "owner" })) },
    };
    const prev = process.env.BCRYPT_ROUNDS;
    process.env.BCRYPT_ROUNDS = "4";
    try {
      await createTenantWithOwner(tx as any, {
        name: "Salón Nuevo",
        slug: "salon-nuevo",
        ownerEmail: "duena@salon.test",
        ownerPassword: "x".repeat(12),
        ownerFirstName: "Ana",
        ownerLastName: "Pérez",
      });
    } finally {
      if (prev === undefined) delete process.env.BCRYPT_ROUNDS;
      else process.env.BCRYPT_ROUNDS = prev;
    }
    const stored = tenantCreate.mock.calls[0][0].data.rebookingSettings;
    expect(stored).toEqual({ enabled: true, leadDays: 3, channelFallback: "email", minVisits: 3 });
    expect(stored).not.toBe(NEW_SALON_REBOOKING_SETTINGS);

    // And the dispatcher reads them as on.
    const prisma = { tenant: { findUnique: jest.fn(async () => ({ rebookingSettings: stored })) } };
    const cfg = await new ClientCadenceService(prisma as any).getTenantConfig("tenant-new");
    expect(cfg).toEqual({ enabled: true, leadDays: 3, channelFallback: "email", minVisits: 3 });
  });

  it("a salon from before keeps the column default (off)", async () => {
    const prisma = { tenant: { findUnique: jest.fn(async () => ({ rebookingSettings: { enabled: false, leadDays: 3, channelFallback: "both", minVisits: 3 } })) } };
    expect((await new ClientCadenceService(prisma as any).getTenantConfig("old")).enabled).toBe(false);
  });
});
