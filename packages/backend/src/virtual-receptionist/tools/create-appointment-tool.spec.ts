import { ConflictException } from "@nestjs/common";
import { SALON_TOOLS, SalonToolsService, executeSalonTool } from "./salon-tools";
import { isAffirmative, MAX_BOOKINGS_PER_CONVERSATION } from "./receptionist-booking";

/**
 * The receptionist books in two steps the server enforces.
 *
 * The first version was one create_appointment call carrying the details and
 * a model-supplied `clientConfirmed: true`. Nothing checked the client's
 * actual reply, and a second call booked again -- with "whoever is free", a
 * duplicate appointment with the next professional.
 */

const SERVICE = "33333333-3333-4333-8333-333333333333";
const PRO = "11111111-1111-4111-8111-111111111111";

const DETAILS = {
  serviceId: SERVICE,
  professionalId: PRO,
  date: "2026-10-05",
  time: "10:00",
  firstName: "Ana",
  lastName: "López",
  email: "ana@mail.test",
};

function setup({
  clientId = "visitor-1",
  channel = "web",
  externalUserId = undefined as string | undefined,
  freeTimes = ["10:00"],
  recentByEmail = 0,
  book = async () => ({ id: "apt-1", service: { name: "Corte" }, professional: { firstName: "Ana", lastName: "García" } }) as any,
} = {}) {
  let context: Record<string, unknown> = {};
  let userTurns = 1;
  const booked: any[] = [];
  const prisma: any = {
    chatConversation: {
      findUnique: async () => ({ context }),
      update: async ({ data }: any) => { context = data.context; },
    },
    chatMessage: { count: async () => userTurns },
    appointment: { count: async () => recentByEmail },
  };
  const appointmentsService: any = {
    getAvailableSlots: jest.fn(async () => freeTimes.map((time) => ({ time, isAvailable: true }))),
    bookOnline: jest.fn(async (...args: any[]) => { booked.push(args); return book(); }),
  };
  const service = new SalonToolsService({} as any, {} as any);
  let lastUserMessage = "Quiero un corte el lunes a las 10";
  const ctx = () => ({
    prisma,
    tenantId: "tenant-b",
    appointmentsService,
    conversation: { id: "conv-1", clientId, lastUserMessage, channel, externalUserId },
  });
  const run = (name: string, input: object = {}) => executeSalonTool(service, name, input, ctx());
  /** The client writes a new message. */
  const say = (text: string) => { userTurns += 1; lastUserMessage = text; };
  return { run, say, booked, appointmentsService, state: () => context };
}

describe("the tools the model sees", () => {
  it("offers propose_appointment with the email required, and create_appointment with no details", () => {
    const propose: any = SALON_TOOLS.find((t) => t.name === "propose_appointment");
    const create: any = SALON_TOOLS.find((t) => t.name === "create_appointment");
    expect(propose.input_schema.required).toEqual(expect.arrayContaining(["serviceId", "date", "time", "email"]));
    expect(create.input_schema.properties).toEqual({});
  });
});

describe("propose, then book on a real yes", () => {
  it("books the stored proposal once the client replies yes", async () => {
    const { run, say, booked } = setup();

    expect(await run("propose_appointment", DETAILS)).toMatchObject({ proposed: true });
    say("Sí, perfecto");
    const out = await run("create_appointment");

    expect(out).toMatchObject({ created: true, appointmentId: "apt-1", professional: "Ana García" });
    const [tenantId, dto] = booked[0];
    expect(tenantId).toBe("tenant-b");
    expect(dto).toMatchObject({
      serviceId: SERVICE,
      professionalId: PRO,
      scheduledDate: "2026-10-05",
      scheduledTime: "10:00",
      clientInfo: { firstName: "Ana", lastName: "López", email: "ana@mail.test" },
    });
  });

  it("refuses to book in the same turn as the proposal", async () => {
    // The model cannot propose and book before the client has answered.
    const { run, booked } = setup();

    await run("propose_appointment", DETAILS);
    expect(await run("create_appointment")).toMatchObject({ created: false, error: "not_confirmed" });
    expect(booked).toHaveLength(0);
  });

  it("refuses when the client's reply is not a yes", async () => {
    const { run, say, booked } = setup();

    await run("propose_appointment", DETAILS);
    say("¿y el martes a las 10?");
    expect(await run("create_appointment")).toMatchObject({ created: false, error: "not_confirmed" });
    say("sí, pero a las 11");
    expect(await run("create_appointment")).toMatchObject({ created: false, error: "not_confirmed" });
    expect(booked).toHaveLength(0);
  });

  it("never books the same proposal twice", async () => {
    const { run, say, booked } = setup();

    await run("propose_appointment", DETAILS);
    say("sí");
    await run("create_appointment");
    say("sí, gracias");
    const again = await run("create_appointment");

    expect(again).toMatchObject({ created: true, alreadyBooked: true, appointmentId: "apt-1" });
    expect(booked).toHaveLength(1);
  });

  it("needs a proposal first", async () => {
    const { run, say } = setup();
    say("sí");
    expect(await run("create_appointment")).toMatchObject({ created: false, error: "nothing_proposed" });
  });
});

describe("what a proposal checks", () => {
  it("names the missing field, not just clientInfo", async () => {
    const { run } = setup();
    const out: any = await run("propose_appointment", { ...DETAILS, email: "ana@" });
    expect(out).toMatchObject({ proposed: false, error: "invalid_input" });
    expect(out.fields).toEqual(["clientInfo.email"]);
  });

  it("refuses a slot that cannot be booked online", async () => {
    const { run, appointmentsService } = setup({ freeTimes: ["11:00"] });
    expect(await run("propose_appointment", DETAILS)).toMatchObject({ proposed: false, error: "slot_unavailable" });
    expect(appointmentsService.getAvailableSlots.mock.calls[0][6]).toEqual({ onlineWindow: true });
  });

  it("keeps the WhatsApp number when the model does not pass a phone", async () => {
    const { run, say, booked } = setup({ channel: "whatsapp", externalUserId: "34600111222" });
    await run("propose_appointment", DETAILS);
    say("sí");
    await run("create_appointment");
    expect(booked[0][1].clientInfo.phone).toBe("+34600111222");
  });
});

describe("limits", () => {
  it("does not book from a shared anonymous session", async () => {
    const { run } = setup({ clientId: "anonymous" });
    expect(await run("propose_appointment", DETAILS)).toMatchObject({ error: "anonymous_session" });
  });

  it(`allows ${MAX_BOOKINGS_PER_CONVERSATION} bookings per conversation`, async () => {
    const { run, say } = setup();
    for (let i = 0; i < MAX_BOOKINGS_PER_CONVERSATION; i++) {
      await run("propose_appointment", DETAILS);
      say("sí");
      expect(await run("create_appointment")).toMatchObject({ created: true });
    }
    await run("propose_appointment", DETAILS);
    say("sí");
    expect(await run("create_appointment")).toMatchObject({ created: false, error: "too_many_bookings" });
  });

  it("caps chat bookings per email per day", async () => {
    const { run, say, booked } = setup({ recentByEmail: 3 });
    await run("propose_appointment", DETAILS);
    say("sí");
    expect(await run("create_appointment")).toMatchObject({ created: false, error: "too_many_bookings" });
    expect(booked).toHaveLength(0);
  });

  it("relays a slot taken meanwhile as an answer, not a crash", async () => {
    const { run, say } = setup({
      book: async () => {
        throw new ConflictException("Ese horario ya no está disponible");
      },
    });
    await run("propose_appointment", DETAILS);
    say("sí");
    expect(await run("create_appointment")).toMatchObject({ created: false, error: "slot_unavailable" });
  });
});

describe("isAffirmative", () => {
  it.each(["sí", "Si", "Sí, perfecto", "vale", "ok", "de acuerdo", "confirmo", "correcto", "yes", "sure!", "that's right"])(
    "reads %p as yes",
    (text) => expect(isAffirmative(text)).toBe(true),
  );
  it.each(["no", "sí, pero a las 11", "¿y el martes?", "espera", "cambia la hora", "no sé", "si pudiera ser a las 11", "hola"])(
    "does not read %p as yes",
    (text) => expect(isAffirmative(text)).toBe(false),
  );
});
