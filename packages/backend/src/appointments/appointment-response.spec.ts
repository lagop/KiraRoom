import { Prisma } from "@prisma/client";
import { firstValueFrom, of } from "rxjs";
import { ScrubSecretsInterceptor, publicBooking, scrubSecrets } from "./appointment-response";

/**
 * Appointment responses carried the client, professional and tenant rows
 * whole: the salon's Stripe secret keys and channel tokens, and the client's
 * password hash. The public booking endpoint returned all of it to anyone
 * who booked.
 */
const appointment = () => ({
  id: "apt-1",
  status: "pending",
  scheduledDate: new Date("2026-10-08T00:00:00.000Z"),
  scheduledTime: "10:00",
  totalAmount: new Prisma.Decimal(45),
  client: {
    id: "c1",
    firstName: "Ana",
    email: "ana@mail.test",
    phone: "+34600111222",
    allergies: "látex",
    passwordHash: "$2b$12$hash",
  },
  professional: { id: "p1", firstName: "Laura", lastName: "Díaz", userId: "u1" },
  service: { id: "s1", name: "Corte", duration: 60, price: new Prisma.Decimal(45) },
  tenant: {
    id: "t1",
    name: "Salón",
    timezone: "Europe/Madrid",
    minCancelHours: 24,
    stripeLiveSecretKey: "sk_live_x",
    stripeTestSecretKey: "sk_test_x",
    features: { telegramBotToken: "secret" },
    fiscalNif: "B00000000",
  },
  services: [{ id: "as1", professional: { id: "p1" }, service: { id: "s1" } }],
});

describe("scrubSecrets", () => {
  it("never returns a Stripe secret key, a channel token or a password hash", () => {
    const out: any = scrubSecrets(appointment());
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/sk_live_x|sk_test_x|telegramBotToken|\$2b\$12/);
    expect(out.client).not.toHaveProperty("passwordHash");
  });

  it("keeps only the tenant's public fields", () => {
    const out: any = scrubSecrets(appointment());
    expect(out.tenant).toEqual({ id: "t1", name: "Salón", timezone: "Europe/Madrid", minCancelHours: 24 });
  });

  it("leaves dates, amounts and lists as they are", () => {
    const out: any = scrubSecrets([appointment()]);
    expect(out[0].scheduledDate).toBeInstanceOf(Date);
    expect(out[0].totalAmount).toBeInstanceOf(Prisma.Decimal);
    expect(out[0].client.allergies).toBe("látex");
    expect(out[0].services[0].professional.id).toBe("p1");
  });

  it("runs on everything the controller returns", async () => {
    const interceptor = new ScrubSecretsInterceptor();
    const body: any = await firstValueFrom(interceptor.intercept({} as any, { handle: () => of(appointment()) }) as any);
    expect(JSON.stringify(body)).not.toMatch(/sk_live_x|\$2b\$12/);
  });
});

describe("publicBooking", () => {
  it("answers a public booking with the booking only", () => {
    const out = publicBooking(appointment());
    expect(Object.keys(out).sort()).toEqual(
      ["id", "professional", "scheduledDate", "scheduledTime", "service", "status"].sort(),
    );
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/ana@mail\.test|600111222|látex|sk_live|Salón|u1/);
  });
});
