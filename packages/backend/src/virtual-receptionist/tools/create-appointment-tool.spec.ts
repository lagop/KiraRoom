import { ConflictException } from "@nestjs/common";
import { SALON_TOOLS, SalonToolsService, executeSalonTool } from "./salon-tools";

/**
 * The receptionist can book. Until this tool existed it could collect every
 * detail and then do nothing with them, while its prompt told it to announce
 * a registration that had not happened.
 *
 * It books through AppointmentsService.bookOnline -- the public site's path,
 * with its validation, booking window and lock -- for the salon the
 * receptionist answers for.
 */

const SERVICE = "33333333-3333-4333-8333-333333333333";
const PRO = "11111111-1111-4111-8111-111111111111";

const INPUT = {
  serviceId: SERVICE,
  professionalId: PRO,
  date: "2026-10-05",
  time: "10:00",
  firstName: "Ana",
  lastName: "López",
  email: "ana@mail.test",
  clientConfirmed: true,
};

function setup(bookOnline: (...args: any[]) => Promise<any>) {
  const calls: any[] = [];
  const appointmentsService: any = {
    bookOnline: async (...args: any[]) => {
      calls.push(args);
      return bookOnline(...args);
    },
  };
  const service = new SalonToolsService({} as any, {} as any);
  const ctx: any = { prisma: {}, tenantId: "tenant-b", appointmentsService };
  const run = (input: object) => executeSalonTool(service, "create_appointment", input, ctx);
  return { run, calls };
}

const BOOKED = async () => ({
  id: "apt-1",
  service: { name: "Corte" },
  professional: { firstName: "Ana", lastName: "García" },
});

describe("create_appointment", () => {
  it("is offered to the model, with the email required", () => {
    const tool: any = SALON_TOOLS.find((t) => t.name === "create_appointment");
    expect(tool).toBeDefined();
    expect(tool.input_schema.required).toEqual(
      expect.arrayContaining(["serviceId", "date", "time", "email", "clientConfirmed"]),
    );
  });

  it("books in the receptionist's own salon, through bookOnline", async () => {
    const { run, calls } = setup(BOOKED);

    const out = await run(INPUT);

    expect(out).toMatchObject({ created: true, appointmentId: "apt-1", service: "Corte", professional: "Ana García" });
    const [tenantId, dto] = calls[0];
    expect(tenantId).toBe("tenant-b");
    expect(dto).toMatchObject({
      serviceId: SERVICE,
      professionalId: PRO,
      scheduledDate: "2026-10-05",
      scheduledTime: "10:00",
      clientInfo: { firstName: "Ana", lastName: "López", email: "ana@mail.test" },
    });
  });

  it("refuses to book until the client has said yes", async () => {
    const { run, calls } = setup(BOOKED);

    for (const clientConfirmed of [false, undefined, "true"]) {
      expect(await run({ ...INPUT, clientConfirmed })).toMatchObject({ created: false, error: "not_confirmed" });
    }
    expect(calls).toHaveLength(0);
  });

  it("asks for what is missing instead of booking without an email", async () => {
    const { run, calls } = setup(BOOKED);

    const out: any = await run({ ...INPUT, email: undefined });

    expect(out).toMatchObject({ created: false, error: "invalid_input" });
    expect(out.fields).toContain("clientInfo");
    expect(calls).toHaveLength(0);
  });

  it("relays a taken slot as an answer, not a crash", async () => {
    const { run } = setup(async () => {
      throw new ConflictException("Ese horario ya no está disponible");
    });

    expect(await run(INPUT)).toMatchObject({ created: false, error: "slot_unavailable" });
  });

  it("lets 'whoever is free' through without a professional", async () => {
    const { run, calls } = setup(BOOKED);

    await run({ ...INPUT, professionalId: undefined });

    expect(calls[0][1].professionalId).toBeUndefined();
  });
});
