import { WidgetService, widgetLocations } from "./widget.service";

/**
 * The booking widget (/embed/<token>) gets the location step the public
 * booking page has (#216): a salon with two or more locations to book at
 * sends them, each professional says where they work and which services
 * they do. Narrowed to the widget's own professionals.
 */
const CENTRO = { id: "loc-c", name: "Centro", slug: "centro", street: "Calle Mayor 1", city: "Madrid", state: null, postalCode: "28013", phone: "910000001" };
const NORTE = { id: "loc-n", name: "Norte", slug: "norte", street: null, city: "Madrid", state: null, postalCode: null, phone: null };
const LINKS = [
  { professionalId: "ana", locationId: "loc-c", isPrimary: true },
  { professionalId: "bea", locationId: "loc-n", isPrimary: true },
  { professionalId: "bea", locationId: "loc-c", isPrimary: false },
];

function build(widgetProfessionals: string[], locationRows = [CENTRO, NORTE]) {
  const professionals = [
    { id: "ana", firstName: "Ana", lastName: "A", bio: null, profileImage: null, specialties: [], services: [{ serviceId: "s1" }] },
    { id: "bea", firstName: "Bea", lastName: "B", bio: null, profileImage: null, specialties: [], services: [{ serviceId: "s2" }] },
  ];
  const prisma: any = {
    widgetInstance: {
      findUnique: jest.fn(async () => ({
        id: "w1",
        tenantId: "t1",
        name: "Web",
        allowedOrigins: [],
        theme: {},
        services: [],
        professionals: widgetProfessionals,
        tenant: { id: "t1", name: "Salón Luna", slug: "salon-luna", fiscalSettings: { pricesIncludeTax: true } },
      })),
    },
    professional: {
      findMany: jest.fn(async (args: any) =>
        professionals.filter((p) => !args.where.id || args.where.id.in.includes(p.id)),
      ),
    },
    service: { findMany: jest.fn(async () => []) },
    location: { findMany: jest.fn(async () => locationRows) },
    professionalLocation: {
      findMany: jest.fn(async () => LINKS.filter((l) => locationRows.some((r) => r.id === l.locationId))),
    },
    whatsAppConnection: { findUnique: jest.fn(async () => null) },
  };
  return { prisma, service: new WidgetService(prisma) };
}

describe("widget location step", () => {
  it("sends the locations, where each professional works and what they do", async () => {
    const { service, prisma } = build([]);
    const config: any = await service.getPublicConfig("w1");
    expect(config.locations).toEqual([
      { id: "loc-c", name: "Centro", slug: "centro", address: "Calle Mayor 1, 28013 Madrid", phone: "910000001" },
      { id: "loc-n", name: "Norte", slug: "norte", address: "Madrid", phone: null },
    ]);
    const bea = config.professionals.find((p: any) => p.id === "bea");
    expect(bea).toMatchObject({ locationIds: ["loc-c", "loc-n"], primaryLocationId: "loc-n", services: [{ serviceId: "s2" }] });
    // Only open locations of this salon, with an active professional.
    expect(prisma.location.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", isActive: true });
  });

  it("a salon with one location: no step, professionals as before", async () => {
    const { service } = build([], [CENTRO]);
    const config: any = await service.getPublicConfig("w1");
    expect(config.locations).toEqual([]);
    expect(config.professionals[0]).not.toHaveProperty("locationIds");
  });

  it("a widget limited to professionals of one location: no step", async () => {
    const { service } = build(["ana"]);
    const config: any = await service.getPublicConfig("w1");
    expect(config.locations).toEqual([]);
    expect(config.professionals.map((p: any) => p.id)).toEqual(["ana"]);
  });

  it("widgetLocations keeps only the locations and links of the widget's professionals", () => {
    const where = {
      locations: [
        { ...CENTRO, professionalIds: ["ana", "bea"] },
        { ...NORTE, professionalIds: ["bea"] },
        { ...NORTE, id: "loc-s", name: "Sur", professionalIds: ["cris"] },
      ],
      links: [...LINKS, { professionalId: "cris", locationId: "loc-s", isPrimary: true }],
    };
    const out = widgetLocations(where, ["ana", "bea"]);
    expect(out.locations.map((l) => l.id)).toEqual(["loc-c", "loc-n"]);
    expect(out.links).toEqual(LINKS);
    expect(widgetLocations(where, ["cris"])).toEqual({ locations: [], links: [] });
  });
});
