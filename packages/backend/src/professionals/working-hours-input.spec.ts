import { BadRequestException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ProfessionalsController } from "./professionals.controller";
import { AdminProfessionalsController } from "../admin/professionals/professionals.controller";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { bodyParser } from "../common/validation/validated-body.testing";
import { normalizeWorkingHours, workingHoursProblem } from "./working-hours-input";

/**
 * The weekly schedule a professional create or update may carry.
 *
 * `workingHours` was `any[]` on all four DTOs: a shift ending before it
 * started, "lunes" for a day, or two overlapping afternoons were stored, and
 * availability then skipped them in silence -- the professional just stopped
 * being bookable that day. Now the body is refused with the reason, and what
 * is stored is normalised.
 */

const SPLIT = [
  { day: "monday", openTime: "10:00", closeTime: "14:00" },
  { day: "monday", openTime: "17:00", closeTime: "20:00" },
];

const BODIES = [
  ["POST /professionals", bodyParser(ProfessionalsController, "create"), { firstName: "Lucía", lastName: "Gil", email: "lucia@example.com" }],
  ["PUT /professionals/:id", bodyParser(ProfessionalsController, "update"), {}],
  ["POST /admin/professionals", bodyParser(AdminProfessionalsController, "create"), { firstName: "Lucía", lastName: "Gil" }],
  ["PATCH /admin/professionals/:id", bodyParser(AdminProfessionalsController, "update"), {}],
] as const;

/** The 400's messages, or null when the body was accepted. */
async function refusal(parse: (body: unknown) => Promise<any>, body: unknown): Promise<string[] | null> {
  try {
    await parse(body);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    const message = ((e as BadRequestException).getResponse() as { message: string[] | string }).message;
    return Array.isArray(message) ? message : [message];
  }
}

describe.each(BODIES)("%s workingHours", (_route, parse, rest) => {
  it("accepts a split day and leaves it out when absent", async () => {
    const out = await parse({ ...rest, workingHours: SPLIT });
    expect(out.workingHours).toEqual(SPLIT);
    expect((await parse({ ...rest })).workingHours).toBeUndefined();
  });

  it("normalises: lower-case days, HH:MM, Monday first, shifts by start, no extra keys", async () => {
    const out = await parse({
      ...rest,
      workingHours: [
        { day: "Tuesday", openTime: "9:00", closeTime: "18:00" },
        { day: "monday", openTime: "17:00", closeTime: "20:00", note: "tarde" },
        { day: " MONDAY ", openTime: "10:00", closeTime: "14:00" },
      ],
    });
    expect(out.workingHours).toEqual([
      { day: "monday", openTime: "10:00", closeTime: "14:00" },
      { day: "monday", openTime: "17:00", closeTime: "20:00" },
      { day: "tuesday", openTime: "09:00", closeTime: "18:00" },
    ]);
  });

  it("refuses overlapping shifts with the reason, in Spanish", async () => {
    const messages = await refusal(parse, {
      ...rest,
      workingHours: [
        { day: "monday", openTime: "10:00", closeTime: "14:00" },
        { day: "monday", openTime: "13:00", closeTime: "17:00" },
      ],
    });
    expect(messages).toContain("Los tramos del lunes se solapan (10:00–14:00 y 13:00–17:00).");
  });

  it("refuses a shift that ends before it starts", async () => {
    const messages = await refusal(parse, {
      ...rest,
      workingHours: [{ day: "friday", openTime: "18:00", closeTime: "09:00" }],
    });
    expect(messages).toContain("El tramo del viernes termina (09:00) antes de empezar (18:00).");
  });
});

describe("workingHoursProblem", () => {
  it("accepts shifts that touch, and an empty schedule", () => {
    expect(
      workingHoursProblem([
        { day: "monday", openTime: "10:00", closeTime: "14:00" },
        { day: "monday", openTime: "14:00", closeTime: "18:00" },
      ]),
    ).toBeNull();
    expect(workingHoursProblem([])).toBeNull();
  });

  it("names what is wrong", () => {
    expect(workingHoursProblem("lunes a viernes")).toBe("El horario debe ser una lista de tramos.");
    expect(workingHoursProblem([{ day: "monday", openTime: "10:00" }])).toBe(
      "Cada tramo del horario necesita día, hora de inicio y hora de fin.",
    );
    expect(workingHoursProblem([{ day: "lunes", openTime: "10:00", closeTime: "14:00" }])).toBe(
      '"lunes" no es un día de la semana válido.',
    );
    expect(workingHoursProblem([{ day: "monday", openTime: "25:00", closeTime: "26:00" }])).toBe(
      'La hora "25:00" no es válida: usa el formato HH:MM.',
    );
    expect(workingHoursProblem([{ day: "monday", openTime: "10:00", closeTime: "10:00" }])).toMatch(
      /termina \(10:00\) antes de empezar \(10:00\)/,
    );
  });

  it("allows at most 21 shifts", () => {
    const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    const three = (day: string) => [
      { day, openTime: "08:00", closeTime: "10:00" },
      { day, openTime: "11:00", closeTime: "13:00" },
      { day, openTime: "14:00", closeTime: "16:00" },
    ];
    const full = days.flatMap(three);
    expect(workingHoursProblem(full)).toBeNull();
    expect(workingHoursProblem([...full, { day: "monday", openTime: "17:00", closeTime: "18:00" }])).toMatch(
      /como máximo 21 tramos/,
    );
  });

  it("leaves what it cannot read for the validator to refuse", () => {
    expect(normalizeWorkingHours("todo el día")).toBe("todo el día");
    const odd = [{ day: "monday" }];
    expect(normalizeWorkingHours(odd)).toBe(odd);
  });
});

describe("who may change a schedule", () => {
  // Staff have no route that writes a professional row: RolesGuard refuses
  // any route that does not list their role, and these four are the only
  // ones that accept workingHours.
  const rolesOf = (handler: unknown, controller: unknown) =>
    (Reflect.getMetadata(ROLES_KEY, handler as object) ?? Reflect.getMetadata(ROLES_KEY, controller as object)) as
      | UserRole[]
      | undefined;

  it.each([
    ["POST /professionals", ProfessionalsController.prototype.create, ProfessionalsController],
    ["PUT /professionals/:id", ProfessionalsController.prototype.update, ProfessionalsController],
    ["POST /admin/professionals", AdminProfessionalsController.prototype.create, AdminProfessionalsController],
    ["PATCH /admin/professionals/:id", AdminProfessionalsController.prototype.update, AdminProfessionalsController],
  ])("%s is for owners and admins only", (_route, handler, controller) => {
    expect([...(rolesOf(handler, controller) ?? [])].sort()).toEqual([UserRole.admin, UserRole.owner]);
  });
});
