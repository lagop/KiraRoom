import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { UpdateTenantDto } from "./dto/update-tenant.dto";
import { AuthService } from "./auth.service";

/**
 * Every salon signed up on Europe/Madrid, wherever it was. A salon in Las
 * Palmas kept Peninsula time: its calendar, availability and reminders were
 * an hour off from what the salon's clock reads.
 *
 *   - sign-up takes the browser's zone when it is one a salon can be in;
 *   - saving an address in the Canary Islands moves a salon still on Madrid
 *     time to Atlantic/Canary (onboarding's address step and the salon
 *     settings both save through PATCH /auth/tenant);
 *   - a zone the runtime does not know is refused, since every salon-time
 *     computation would throw on it.
 */

const errorsFor = (body: object) =>
  validateSync(plainToInstance(UpdateTenantDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

describe("UpdateTenantDto timezone", () => {
  it("accepts an IANA zone, and an empty one as not sent", () => {
    expect(errorsFor({ timezone: "Atlantic/Canary" })).toEqual([]);
    expect(errorsFor({ timezone: "" })).toEqual([]);
  });

  it("refuses a zone that does not exist", () => {
    expect(errorsFor({ timezone: "Europe/Las_Palmas" })).toEqual(["timezone"]);
    expect(errorsFor({ timezone: "GMT+1 Canarias" })).toEqual(["timezone"]);
  });
});

function serviceWith(current: Record<string, unknown>) {
  const writes: any[] = [];
  const service = Object.create(AuthService.prototype);
  service.logger = { log: jest.fn() };
  service.prisma = {
    tenant: {
      findUnique: async () => current,
      update: async ({ data }: any) => {
        writes.push(data);
        return { ...current, ...data };
      },
    },
  };
  return { service, writes };
}

describe("updateTenant: the address decides Canary time", () => {
  const onMadrid = { timezone: "Europe/Madrid", street: null, city: null, postalCode: null, state: null, country: "ES" };

  it("a Canarian address on Madrid time moves the salon to Atlantic/Canary", async () => {
    const { service, writes } = serviceWith(onMadrid);
    const saved = await service.updateTenant("t1", { street: "Calle Ficticia 1", city: "Las Palmas de Gran Canaria" });
    expect(writes[0].timezone).toBe("Atlantic/Canary");
    expect(saved.timezone).toBe("Atlantic/Canary");
  });

  it("by its postcode too (38xxx, Santa Cruz de Tenerife)", async () => {
    const { service, writes } = serviceWith({ ...onMadrid, city: "Pueblo Inventado" });
    await service.updateTenant("t1", { postalCode: "38001" });
    expect(writes[0].timezone).toBe("Atlantic/Canary");
  });

  it("an address on the Peninsula, or in Palma de Mallorca, stays on Madrid time", async () => {
    for (const city of ["Madrid", "Palma de Mallorca", "Palma"]) {
      const { service, writes } = serviceWith(onMadrid);
      await service.updateTenant("t1", { street: "Calle Ficticia 1", city });
      expect(writes[0].timezone).toBeUndefined();
    }
  });

  it("a zone sent with the address is the owner's choice", async () => {
    const { service, writes } = serviceWith(onMadrid);
    await service.updateTenant("t1", { city: "Las Palmas", timezone: "Europe/Madrid" });
    expect(writes[0].timezone).toBe("Europe/Madrid");
  });

  it("a salon on any other zone keeps it", async () => {
    const { service, writes } = serviceWith({ ...onMadrid, timezone: "Europe/Lisbon" });
    await service.updateTenant("t1", { city: "Las Palmas" });
    expect(writes[0].timezone).toBeUndefined();
  });

  it("a save without address fields does not look at the address", async () => {
    const { service, writes } = serviceWith({ ...onMadrid, city: "Las Palmas" });
    const findUnique = jest.spyOn(service.prisma.tenant, "findUnique");
    await service.updateTenant("t1", { name: "Salón de Prueba" });
    expect(findUnique).not.toHaveBeenCalled();
    expect(writes[0]).toEqual({ name: "Salón de Prueba" });
  });

  it("an address abroad is never Canarian, whatever its postcode", async () => {
    const { service, writes } = serviceWith({ ...onMadrid, country: "PT" });
    await service.updateTenant("t1", { postalCode: "35000" });
    expect(writes[0].timezone).toBeUndefined();
  });
});

describe("register: the browser's zone", () => {
  function buildAuth() {
    const created: any[] = [];
    const prisma: any = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: any) => ({ id: "u1", email: data.email, role: data.role })),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      tenant: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return { id: "t1" };
        }),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const auth = new AuthService(
      prisma,
      { sign: jest.fn().mockReturnValue("signed-jwt"), verify: jest.fn() } as any,
      { record: jest.fn() } as any,
      { record: jest.fn(), recordOnce: jest.fn().mockResolvedValue(undefined) } as any,
      {
        sendWelcome: jest.fn().mockResolvedValue({ success: true }),
        sendEmailVerification: jest.fn().mockResolvedValue({ success: true }),
      } as any,
      { start: jest.fn(async () => ({ sid: "sid-1", jti: "jti-1" })), rotate: jest.fn() } as any,
      {} as any,
    );
    // The activation email is fire-and-forget; keep it out of the test.
    (auth as any).sendActivationEmail = jest.fn().mockResolvedValue(undefined);
    return { auth, created };
  }

  const form = {
    email: "duena@salon-ficticio.test",
    password: "contraseña-de-prueba",
    salonName: "Salón Ficticio",
    phone: "+34 600 000 000",
    ownerName: "Ana Prueba",
    acceptTerms: true,
  };

  it("a sign-up from the Canaries starts on Canary time", async () => {
    const { auth, created } = buildAuth();
    await auth.register({ ...form, timezone: "Atlantic/Canary" } as any);
    expect(created[0].timezone).toBe("Atlantic/Canary");
  });

  it("a zone a salon cannot be in, or none, starts on Madrid time", async () => {
    for (const timezone of ["Asia/Tokyo", "Not/AZone", undefined]) {
      const { auth, created } = buildAuth();
      await auth.register({ ...form, timezone } as any);
      expect(created[0].timezone).toBe("Europe/Madrid");
    }
  });
});
