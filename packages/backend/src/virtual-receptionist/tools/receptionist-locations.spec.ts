import { executeSalonTool, SALON_TOOLS, SalonToolsService } from "./salon-tools";
import { locationsMentioned, pickLocation, resolveLocation } from "./receptionist-locations";

/**
 * The receptionist at a salon with several locations (multi-local): it asks
 * or works out which one, and passes it to availability and booking. No LLM
 * here: the tools are called as the model would call them.
 */

const SERVICE = "33333333-3333-4333-8333-333333333333";
const CARMEN = "11111111-1111-4111-8111-111111111111"; // Centro only
const ANA = "22222222-2222-4222-8222-222222222222"; // Centro and Chamberí, Chamberí her main one
const LUIS = "44444444-4444-4444-8444-444444444444"; // Chamberí only
const DANI = "55555555-5555-4555-8555-555555555555"; // no location
const CENTRO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAMBERI = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const NAMES: Record<string, { firstName: string; lastName: string }> = {
  [CARMEN]: { firstName: "Carmen", lastName: "Sánchez" },
  [ANA]: { firstName: "Ana", lastName: "Martínez" },
  [LUIS]: { firstName: "Luis", lastName: "Gil" },
  [DANI]: { firstName: "Dani", lastName: "Ruiz" },
};

const LOCATION_ROWS = [
  { id: CENTRO, name: "Centro", slug: "centro", street: "Calle Mayor 1", city: "Madrid", state: "Madrid", postalCode: "28013", phone: "910000001" },
  { id: CHAMBERI, name: "Chamberí", slug: "chamberi", street: "Calle Fuencarral 120", city: "Madrid", state: "Madrid", postalCode: "28010", phone: null },
];
const LINKS = [
  { professionalId: CARMEN, locationId: CENTRO, isPrimary: true },
  { professionalId: ANA, locationId: CENTRO, isPrimary: false },
  { professionalId: ANA, locationId: CHAMBERI, isPrimary: true },
  { professionalId: LUIS, locationId: CHAMBERI, isPrimary: true },
];

const DETAILS = {
  serviceId: SERVICE,
  date: "2026-11-09",
  time: "10:00",
  firstName: "Lucía",
  lastName: "Pérez",
  phone: "600 111 222",
};

function setup({ locations = LOCATION_ROWS, links = LINKS, message = "Quiero un corte el lunes a las 10" } = {}) {
  let context: Record<string, unknown> = {};
  let userTurns = 1;
  let lastUserMessage = message;
  const prisma: any = {
    chatConversation: {
      findUnique: async () => ({ context }),
      update: async ({ data }: any) => {
        context = data.context;
      },
    },
    chatMessage: { count: async () => userTurns },
    tenant: {
      findUnique: async () => ({
        fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21 },
        name: "Salón Luna",
        openingHours: null,
      }),
    },
    appointment: { findMany: async () => [] },
    service: {
      findFirst: async () => ({ name: "Corte", duration: 30, price: 20, currency: "EUR", isOnlineBookable: true }),
      findMany: async () => [{ id: SERVICE, name: "Corte" }],
    },
    professional: {
      findFirst: async ({ where }: any) => NAMES[where.id] ?? null,
      findMany: async ({ where }: any = {}) =>
        Object.entries(NAMES)
          .filter(([id]) => !where?.id?.in || where.id.in.includes(id))
          .map(([id, n]) => ({ id, ...n, services: [], workingHours: [] })),
    },
    location: { findMany: jest.fn(async () => locations) },
    professionalLocation: { findMany: jest.fn(async () => links) },
  };
  const appointmentsService: any = {
    getAvailableSlots: jest.fn(async () => [{ time: "10:00", isAvailable: true }]),
    bookOnline: jest.fn(async () => ({ id: "apt-1", service: { name: "Corte" }, professional: NAMES[ANA] })),
    findFreeProfessional: jest.fn(async () => LUIS),
  };
  const service = new SalonToolsService({} as any, {} as any);
  const ctx = () =>
    ({
      prisma,
      tenantId: "tenant-a",
      appointmentsService,
      conversation: { id: "conv-1", clientId: "visitor-1", lastUserMessage, channel: "web" },
    }) as any;
  const run = (name: string, input: object = {}) => executeSalonTool(service, name, input, ctx());
  const say = (text: string) => {
    userTurns += 1;
    lastUserMessage = text;
  };
  return { run, say, ctx, prisma, appointmentsService, state: () => context };
}

const ROWS = LOCATION_ROWS.map((l) => ({ ...l, professionalIds: [] as string[] }));

describe("naming a location", () => {
  it("by id, slug, name without accents, or a unique part of its name or address", () => {
    expect(pickLocation(CHAMBERI, ROWS)?.id).toBe(CHAMBERI);
    expect(pickLocation("chamberi", ROWS)?.id).toBe(CHAMBERI);
    expect(pickLocation("Chamberí", ROWS)?.id).toBe(CHAMBERI);
    expect(pickLocation("el de Centro", ROWS)?.id).toBe(CENTRO);
    expect(pickLocation("Fuencarral", ROWS)?.id).toBe(CHAMBERI);
    // Both are in Madrid: no guess.
    expect(pickLocation("Madrid", ROWS)).toBeUndefined();
    expect(pickLocation("Sur", ROWS)).toBeUndefined();
  });

  it("in the client's message, by its name as whole words", () => {
    expect(locationsMentioned("Prefiero ir al de Chamberi mañana", ROWS).map((l) => l.id)).toEqual([CHAMBERI]);
    expect(locationsMentioned("en el centro, por favor", ROWS).map((l) => l.id)).toEqual([CENTRO]);
    expect(locationsMentioned("Quiero un corte", ROWS)).toEqual([]);
    // "concentro" is not "centro".
    expect(locationsMentioned("me concentro mejor por la tarde", ROWS)).toEqual([]);
  });
});

describe("resolveLocation", () => {
  it("a salon with one location: nothing asked, a locationId the model sends is dropped", async () => {
    const { ctx } = setup({ locations: [LOCATION_ROWS[0]] });
    const out = await resolveLocation(ctx(), { serviceId: SERVICE, locationId: CENTRO });
    expect(out).toEqual({ ok: true, args: { serviceId: SERVICE } });
  });

  it("the location the model names, by name", async () => {
    const { ctx } = setup();
    const out = await resolveLocation(ctx(), { serviceId: SERVICE, locationId: "Chamberí" });
    expect(out.args).toMatchObject({ locationId: CHAMBERI });
  });

  it("an unknown one: the options, to try again", async () => {
    const { ctx } = setup();
    const out = await resolveLocation(ctx(), { serviceId: SERVICE, locationId: "Sur" });
    expect(out.error).toMatchObject({ error: "location_not_found" });
    expect((out.error as any).locations.map((l: any) => l.name)).toEqual(["Centro", "Chamberí"]);
  });

  it("from the client's message when the model leaves it out", async () => {
    const { ctx } = setup({ message: "Mejor en Chamberí" });
    const out = await resolveLocation(ctx(), { serviceId: SERVICE });
    expect(out.args).toMatchObject({ locationId: CHAMBERI });
  });

  it("from the professional when they work at only one", async () => {
    const { ctx } = setup();
    const out = await resolveLocation(ctx(), { serviceId: SERVICE, professionalId: CARMEN });
    expect(out.args).toMatchObject({ locationId: CENTRO });
  });

  it("a professional at several, and nothing said: ask among theirs", async () => {
    const { ctx } = setup();
    const out = await resolveLocation(ctx(), { serviceId: SERVICE, professionalId: ANA });
    expect(out.error).toMatchObject({ error: "location_required" });
    expect((out.error as any).locations.map((l: any) => l.id)).toEqual([CENTRO, CHAMBERI]);
  });

  it("nobody named and nothing said: ask which location", async () => {
    const { ctx } = setup();
    const out = await resolveLocation(ctx(), { serviceId: SERVICE });
    expect(out.error).toMatchObject({ error: "location_required" });
    expect((out.error as any).locations).toEqual([
      { id: CENTRO, name: "Centro", address: "Calle Mayor 1, 28013 Madrid" },
      { id: CHAMBERI, name: "Chamberí", address: "Calle Fuencarral 120, 28010 Madrid" },
    ]);
  });

  it("a professional who does not work there: refused, with who does", async () => {
    const { ctx } = setup();
    const out = await resolveLocation(ctx(), { serviceId: SERVICE, professionalId: CARMEN, locationId: "Chamberí" });
    expect(out.error).toMatchObject({ error: "professional_not_at_location" });
    expect((out.error as any).professionals.map((p: any) => p.name).sort()).toEqual(["Ana Martínez", "Luis Gil"]);
    expect((out.error as any).professionalLocations.map((l: any) => l.id)).toEqual([CENTRO]);
  });

  it("a professional assigned to no location, nothing said: booked as before, without one", async () => {
    const { ctx } = setup();
    const out = await resolveLocation(ctx(), { serviceId: SERVICE, professionalId: DANI });
    expect(out).toEqual({ ok: true, args: { serviceId: SERVICE, professionalId: DANI } });
  });

  it("a second location with nobody assigned is no choice: as a single-location salon", async () => {
    const { ctx } = setup({ links: LINKS.filter((l) => l.locationId === CENTRO) });
    const out = await resolveLocation(ctx(), { serviceId: SERVICE, locationId: CHAMBERI });
    expect(out).toEqual({ ok: true, args: { serviceId: SERVICE } });
  });
});

describe("the tools at a salon with several locations", () => {
  it("check_availability and propose_appointment take a locationId", () => {
    for (const name of ["check_availability", "propose_appointment"]) {
      const tool: any = SALON_TOOLS.find((t) => t.name === name);
      expect(tool.input_schema.properties.locationId).toBeDefined();
      expect(tool.input_schema.required).not.toContain("locationId");
    }
  });

  it("check_availability asks for the times at that location", async () => {
    const { run, appointmentsService } = setup();
    const out = await run("check_availability", { serviceId: SERVICE, date: "2026-11-09", locationId: "centro" });
    expect(out).toMatchObject({ locationId: CENTRO, slots: ["10:00"] });
    const opts = appointmentsService.getAvailableSlots.mock.calls[0][6];
    expect(opts).toEqual({ onlineWindow: true, locationId: CENTRO });
  });

  it("check_availability without a location: the model is told to ask, and nothing is looked up", async () => {
    const { run, appointmentsService } = setup();
    const out = await run("check_availability", { serviceId: SERVICE, date: "2026-11-09" });
    expect(out).toMatchObject({ error: "location_required" });
    expect(appointmentsService.getAvailableSlots).not.toHaveBeenCalled();
  });

  it("a booking at the location the client named: summary with its address, booked there", async () => {
    const { run, say, appointmentsService, state } = setup({ message: "En Chamberí, el lunes a las 10" });
    const proposed: any = await run("propose_appointment", DETAILS);
    expect(proposed).toMatchObject({ proposed: true });
    expect(proposed.summary.location).toBe("Chamberí (Calle Fuencarral 120, 28010 Madrid)");
    // Whoever is free there.
    expect(appointmentsService.findFreeProfessional.mock.calls[0][5]).toBe(CHAMBERI);
    expect(appointmentsService.getAvailableSlots.mock.calls[0][6]).toEqual({ onlineWindow: true, locationId: CHAMBERI });
    expect((state().pendingBooking as any).locationId).toBe(CHAMBERI);

    say("Sí, perfecto");
    const booked: any = await run("create_appointment");
    expect(booked).toMatchObject({ created: true, location: "Chamberí (Calle Fuencarral 120, 28010 Madrid)" });
    const dto = appointmentsService.bookOnline.mock.calls[0][1];
    expect(dto.locationId).toBe(CHAMBERI);
  });

  it("a single-location salon books exactly as before: no location anywhere", async () => {
    const { run, say, appointmentsService } = setup({ locations: [LOCATION_ROWS[0]] });
    const proposed: any = await run("propose_appointment", { ...DETAILS, locationId: "Centro" });
    expect(proposed.summary).not.toHaveProperty("location");
    expect(appointmentsService.getAvailableSlots.mock.calls[0][6]).toEqual({ onlineWindow: true });
    expect(appointmentsService.findFreeProfessional.mock.calls[0][5]).toBeUndefined();
    say("Sí");
    await run("create_appointment");
    expect(appointmentsService.bookOnline.mock.calls[0][1].locationId).toBeUndefined();
  });

  it("list_professionals says where each works, get_salon_info lists the locations", async () => {
    const { run } = setup();
    const team: any = await run("list_professionals");
    const byName = Object.fromEntries(team.professionals.map((p: any) => [p.fullName, p.locations]));
    expect(byName["Ana Martínez"]).toEqual(["Centro", "Chamberí"]);
    expect(byName["Carmen Sánchez"]).toEqual(["Centro"]);
    expect(byName["Dani Ruiz"]).toEqual([]);

    const info: any = await run("get_salon_info");
    expect(info.locations).toEqual([
      { id: CENTRO, name: "Centro", address: "Calle Mayor 1, 28013 Madrid", phone: "910000001" },
      { id: CHAMBERI, name: "Chamberí", address: "Calle Fuencarral 120, 28010 Madrid", phone: null },
    ]);
  });

  it("a single-location salon: no locations in the answers", async () => {
    const { run } = setup({ locations: [LOCATION_ROWS[0]] });
    const team: any = await run("list_professionals");
    expect(team.professionals[0]).not.toHaveProperty("locations");
    expect(await run("get_salon_info")).not.toHaveProperty("locations");
  });
});
