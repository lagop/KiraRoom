import { GoneException, NotFoundException } from "@nestjs/common";
import { WidgetService, invalidateTenantWidgets, widgetTheme } from "./widget.service";

/**
 * A widget only works for a salon that exists, and only offers to book while
 * the salon takes bookings: a deleted salon's iframe went on showing its
 * prices and team, and a read-only one's let the client fill everything in
 * to be refused at the end.
 */
function build(tenant: Record<string, unknown>, professionals: any[] = [{ id: "p1", firstName: "Ana", lastName: "M", services: [] }]) {
  const row = {
    id: "w1",
    tenantId: "t1",
    token: "tok",
    name: "Web",
    allowedOrigins: [],
    theme: {},
    services: [],
    professionals: [],
    tenant: {
      id: "t1",
      name: "Salón Luna",
      slug: "salon-luna",
      logo: `data:image/png;base64,${Buffer.from("logo").toString("base64")}`,
      coverImage: null,
      city: "Madrid",
      country: "ES",
      phone: "+34 600 000 000",
      timezone: "Europe/Madrid",
      language: "es",
      fiscalSettings: { pricesIncludeTax: true },
      subscriptionStatus: "active",
      deletedAt: null,
      ...tenant,
    },
  };
  const prisma: any = {
    widgetInstance: { findUnique: jest.fn(async () => row), update: jest.fn(async () => row) },
    professional: { findMany: jest.fn(async () => professionals) },
    location: { findMany: jest.fn(async () => []) },
    professionalLocation: { findMany: jest.fn(async () => []) },
    service: { findMany: jest.fn(async () => []) },
    whatsAppConnection: { findUnique: jest.fn(async () => null) },
  };
  return { service: new WidgetService(prisma), prisma };
}

describe("widget availability", () => {
  it("a deleted salon's widget answers 404 and is not counted as used", async () => {
    const { service, prisma } = build({ deletedAt: new Date() });
    await expect(service.findByToken("tok")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getPublicConfig("w1")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.widgetInstance.update).not.toHaveBeenCalled();
  });

  it("takes bookings while the salon is active, not when it is read-only", async () => {
    expect((await build({}).service.getPublicConfig("w1")).acceptsBookings).toBe(true);
    const readOnlyUntil = new Date(Date.now() + 10 * 86_400_000);
    for (const subscriptionStatus of ["cancelled", "suspended"]) {
      const config = await build({ subscriptionStatus, readOnlyUntil }).service.getPublicConfig("w1");
      expect(config.acceptsBookings).toBe(false);
      // What the widget shows instead of the steps.
      expect(config.tenant.phone).toBe("+34 600 000 000");
    }
  });

  it("with nobody active it takes no bookings yet, and says why (audit 7 N11)", async () => {
    const config = await build({}, []).service.getPublicConfig("w1");
    expect(config.acceptsBookings).toBe(false);
    expect(config.bookingUnavailable).toBe("no_professional");
    expect((await build({}).service.getPublicConfig("w1")).bookingUnavailable).toBeNull();
    const readOnly = await build({ subscriptionStatus: "suspended", readOnlyUntil: new Date(Date.now() + 86_400_000) }, []).service.getPublicConfig("w1");
    expect(readOnly.bookingUnavailable).toBe("read_only");
  });

  it("sends image URLs, not the stored data: URLs", async () => {
    const config = await build({}).service.getPublicConfig("w1");
    expect(config.tenant.logoUrl).toMatch(/^\/public-site\/image\/t1\/logo\?v=/);
    expect(config.tenant.coverImageUrl).toBeNull();
    expect(JSON.stringify(config)).not.toContain("data:");
    expect(JSON.stringify(config)).not.toContain("subscriptionStatus");
  });

  it("deleting a salon replaces every one of its widgets' tokens", async () => {
    const update = jest.fn(async () => ({}));
    const db: any = { widgetInstance: { findMany: jest.fn(async () => [{ id: "w1" }, { id: "w2" }]), update } };
    expect(await invalidateTenantWidgets(db, "t1")).toBe(2);
    expect(db.widgetInstance.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1" });
    const tokens = update.mock.calls.map((c: any[]) => c[0].data.token);
    expect(new Set(tokens).size).toBe(2);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("answers 410 once the salon's page is gone", async () => {
    for (const readOnlyUntil of [null, new Date(Date.now() - 86_400_000)]) {
      await expect(
        build({ subscriptionStatus: "cancelled", readOnlyUntil }).service.getPublicConfig("w1"),
      ).rejects.toBeInstanceOf(GoneException);
    }
  });

  it("serves only a valid hex main colour from the theme", async () => {
    expect(widgetTheme({ primaryColor: "#1A2b3C", other: "x" })).toEqual({ primaryColor: "#1a2b3c" });
    for (const primaryColor of ["red", "#fff", "#12345g", "url(x)", 3, null]) {
      expect(widgetTheme({ primaryColor })).toEqual({ primaryColor: null });
    }
    expect(widgetTheme(null)).toEqual({ primaryColor: null });
    const config = await build({}).service.getPublicConfig("w1");
    expect(config.widget.theme).toEqual({ primaryColor: null });
  });

  it("names the team as the salon shows it on the web, and links its own privacy policy", async () => {
    const { service, prisma } = build({ privacyPolicyUrl: "https://salonluna.example/privacidad" });
    prisma.professional.findMany = jest.fn(async () => [
      { id: "p1", firstName: "Ana", lastName: "García", bio: "x", profileImage: null, specialties: [], webNameDisplay: "initial", webShowPhoto: false, services: [] },
      { id: "p2", firstName: "Bea", lastName: "López", bio: "y", profileImage: null, specialties: [], webNameDisplay: "hidden", webShowPhoto: true, services: [] },
    ]);
    const config: any = await service.getPublicConfig("w1");
    expect(config.professionals.map((p: any) => [p.id, p.firstName, p.lastName, p.listed])).toEqual([
      ["p1", "Ana", "G.", true],
      ["p2", "Profesional", "", false],
    ]);
    expect(JSON.stringify(config)).not.toContain("Bea");
    expect(config.privacyPolicyUrl).toBe("https://salonluna.example/privacidad");
    const select = (prisma.professional.findMany.mock.calls[0] as any[])[0].select;
    expect(select).toMatchObject({ webNameDisplay: true, webShowPhoto: true });
  });
});
