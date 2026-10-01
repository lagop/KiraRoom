import { ValidationPipe } from "@nestjs/common";
import { ImportService } from "./import.service";
import { matchByName, parseTime } from "./columns";

/**
 * Upcoming appointments from the salon's previous program. Moving to
 * KiraRoom meant typing the whole agenda in again; now the export is
 * imported, matched to the salon's services, professionals and clients,
 * with no confirmation sent to anyone.
 */

const DAY = 86_400_000;
/** dd/mm/yyyy, `offset` days from today. */
function day(offset: number): string {
  const d = new Date(Date.now() + offset * DAY);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
const iso = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

function prisma({
  clients = [] as any[],
  professionals = [
    { id: "p-carmen", firstName: "Carmen", lastName: "Sánchez" },
    { id: "p-ana", firstName: "Ana", lastName: "Martínez" },
  ],
  booked = [] as any[],
} = {}) {
  let n = 0;
  let clientsMade = 0;
  return {
    tenant: { findUnique: jest.fn(async () => ({ country: "ES", timezone: "Europe/Madrid" })) },
    service: {
      findMany: jest.fn(async () => [
        { id: "s-corte", name: "Corte mujer", duration: 45, price: 25, currency: "EUR" },
        { id: "s-mani", name: "Manicura semipermanente", duration: 60, price: 22, currency: "EUR" },
      ]),
    },
    professional: { findMany: jest.fn(async () => professionals) },
    client: {
      findMany: jest.fn(async () => clients),
      create: jest.fn(async () => ({ id: `c-new-${++clientsMade}` })),
    },
    appointment: {
      findMany: jest.fn(async () => booked),
      create: jest.fn(async ({ data }: any) => ({ id: `a-${++n}`, ...data })),
    },
    importJob: { create: jest.fn(async () => ({ id: "job1" })) },
  } as any;
}

const HEADER = "Fecha;Hora;Cliente;Teléfono;Servicio;Profesional;Estado\n";

describe("appointment import", () => {
  it("imports future appointments matched to services, professionals and clients", async () => {
    const p = prisma({ clients: [{ id: "c-lucia", firstName: "Lucía", lastName: "Pérez", email: null, phone: "+34600112233" }] });
    const csv =
      HEADER +
      `${day(3)};10:30;Lucía Pérez Gil;600 11 22 33;Corte mujer;Carmen;Confirmada\n` + // client by phone
      `${day(4)};17.00;Begoña Núñez;611 22 33 44;manicura;Ana Martínez;\n`; // new client; "manicura" is the only match
    const out: any = await new ImportService(p).commitAppointments("t1", csv, "agenda.csv");

    expect(out).toMatchObject({ createdRows: 2, errorRows: 0, newClients: 1 });
    const [first, second] = p.appointment.create.mock.calls.map((c: any) => c[0].data);
    expect(first).toMatchObject({
      clientId: "c-lucia",
      serviceId: "s-corte",
      professionalId: "p-carmen",
      scheduledTime: "10:30",
      duration: 45,
      endTime: "11:15",
      status: "confirmed",
      source: "staff",
      reminder24hSent: false,
    });
    expect(first.scheduledDate.toISOString().slice(0, 10)).toBe(iso(3));
    expect(first.startTime).toBeInstanceOf(Date);
    expect(second).toMatchObject({ clientId: "c-new-1", serviceId: "s-mani", professionalId: "p-ana", scheduledTime: "17:00" });
    expect(p.client.create.mock.calls[0][0].data).toMatchObject({ firstName: "Begoña", lastName: "Núñez", phone: "+34611223344" });
  });

  it("leaves out appointments already past or cancelled", async () => {
    const csv =
      HEADER +
      `${day(-2)};10:00;Ana López;600000001;Corte mujer;Carmen;\n` +
      `${day(2)};10:00;Ana López;600000001;Corte mujer;Carmen;Cancelada\n` +
      `${day(2)};11:00;Ana López;600000001;Corte mujer;Carmen;No show\n`;
    const p = prisma();
    const out: any = await new ImportService(p).dryRunAppointments("t1", csv, "agenda.csv");
    expect(out.stats).toMatchObject({ totalRows: 3, okCount: 0, skipCount: 3, invalidCount: 0 });
    expect(out.preview.map((r: any) => r.note)).toEqual([
      "Ya ha pasado",
      "Cancelada en el otro programa",
      "Cancelada en el otro programa",
    ]);
  });

  it("says which service or professional does not match", async () => {
    const csv =
      HEADER +
      `${day(2)};10:00;Ana López;600000001;Tinte raíz;Carmen;\n` +
      `${day(2)};11:00;Ana López;600000001;Corte mujer;Rocío;\n` +
      `${day(2)};12:00;Ana López;600000001;Corte mujer;;\n`;
    const out: any = await new ImportService(prisma()).dryRunAppointments("t1", csv, "agenda.csv");
    expect(out.stats.invalidCount).toBe(3);
    expect(out.preview[0].errors[0].msg).toMatch(/"Tinte raíz" no coincide con ningún servicio/);
    expect(out.preview[1].errors[0].msg).toMatch(/"Rocío" no coincide con ningún profesional/);
    expect(out.preview[2].errors[0].msg).toBe("Falta el profesional");
  });

  it("says when a name could be more than one", async () => {
    const p = prisma({
      professionals: [
        { id: "p1", firstName: "Carmen", lastName: "Sánchez" },
        { id: "p2", firstName: "Carmen", lastName: "Ruiz" },
      ],
    });
    const out: any = await new ImportService(p).dryRunAppointments(
      "t1",
      HEADER + `${day(2)};10:00;Ana López;600000001;Corte mujer;Carmen;\n`,
      "agenda.csv",
    );
    expect(out.preview[0].errors[0].msg).toBe('"Carmen" puede ser varios (Carmen Sánchez, Carmen Ruiz): pon el nombre completo en el archivo');
  });

  it("needs no professional column when the salon has only one", async () => {
    const p = prisma({ professionals: [{ id: "p-only", firstName: "Marta", lastName: "Gil" }] });
    const out: any = await new ImportService(p).commitAppointments(
      "t1",
      `Fecha y hora,Cliente,Servicio\n${day(5)} 09:15,Ana López,Corte mujer\n`,
      "agenda.csv",
    );
    expect(out.createdRows).toBe(1);
    expect(p.appointment.create.mock.calls[0][0].data).toMatchObject({ professionalId: "p-only", scheduledTime: "09:15" });
  });

  it("does not import the same file twice", async () => {
    const booked = [
      { clientId: "c-ana", professionalId: "p-carmen", scheduledDate: new Date(`${iso(2)}T00:00:00Z`), scheduledTime: "10:00" },
    ];
    const p = prisma({ clients: [{ id: "c-ana", firstName: "Ana", lastName: "López", email: null, phone: "+34600000001" }], booked });
    const csv = HEADER + `${day(2)};10:00;Ana López;600000001;Corte mujer;Carmen;\n` + `${day(2)};10:00;Ana López;600000001;Corte mujer;Carmen;\n`;
    const out: any = await new ImportService(p).commitAppointments("t1", csv, "agenda.csv");
    expect(out).toMatchObject({ createdRows: 0, skippedRows: 2 });
    expect(p.appointment.create).not.toHaveBeenCalled();
  });

  it("creates a new client once for all their appointments", async () => {
    const p = prisma();
    const csv = HEADER + `${day(2)};10:00;Eva Sanz;;Corte mujer;Carmen;\n` + `${day(9)};10:00;Eva Sanz;;Corte mujer;Carmen;\n`;
    const dry: any = await new ImportService(p).dryRunAppointments("t1", csv, "agenda.csv");
    expect(dry.newClients).toBe(1);
    expect(dry.preview.map((r: any) => r.note)).toEqual(["Cliente nuevo", undefined]);
    const out: any = await new ImportService(p).commitAppointments("t1", csv, "agenda.csv");
    expect(p.client.create).toHaveBeenCalledTimes(1);
    expect(out.createdRows).toBe(2);
  });

  it("marks the reminders as sent when the salon turns them off", async () => {
    const p = prisma();
    await new ImportService(p).commitAppointments(
      "t1",
      HEADER + `${day(2)};10:00;Ana López;600000001;Corte mujer;Carmen;\n`,
      "agenda.csv",
      { sendReminders: false },
    );
    expect(p.appointment.create.mock.calls[0][0].data).toMatchObject({ reminder24hSent: true, reminder1hSent: true });
  });

  it("keeps the file's own duration and price", async () => {
    const p = prisma();
    await new ImportService(p).commitAppointments(
      "t1",
      `Fecha,Hora,Cliente,Servicio,Profesional,Duración,Precio\n${day(2)},10:00,Ana López,Corte mujer,Carmen,1 h,30\n`,
      "agenda.csv",
    );
    const data = p.appointment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ duration: 60, endTime: "11:00", totalAmount: 3000 });
    expect(Number(data.price)).toBe(30);
  });

  it("sendReminders reaches the handler through the global ValidationPipe", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const { ImportController } = await import("./import.controller");
    const bodyType = Reflect.getMetadata("design:paramtypes", ImportController.prototype, "commitAppointments")[1];
    const body = await pipe.transform({ csv: "a", sendReminders: false }, { type: "body", metatype: bodyType });
    expect(body).toMatchObject({ csv: "a", sendReminders: false });
  });
});

describe("parseTime", () => {
  it.each([
    ["10:30", "10:30"],
    ["9.15", "09:15"],
    ["10h30", "10:30"],
    ["10:30:00", "10:30"],
    ["5:00 PM", "17:00"],
    ["12:00 a. m.", "00:00"],
    ["10 h", "10:00"],
    ["25:00", undefined],
    ["mañana", undefined],
  ])("%s -> %s", (input, expected) => {
    expect(parseTime(input)).toBe(expected);
  });
});

describe("matchByName", () => {
  const pros = [
    { id: 1, names: ["Carmen Sánchez", "Carmen"] },
    { id: 2, names: ["Carmen Ruiz", "Carmen"] },
    { id: 3, names: ["Ana Martínez", "Ana"] },
  ];
  it("matches exactly, without accents or case", () => {
    expect(matchByName("carmen sanchez", pros, (p) => p.names)?.id).toBe(1);
  });
  it("refuses an ambiguous name", () => {
    expect(matchByName("Carmen", pros, (p) => p.names)).toBeNull();
  });
  it("accepts the only partial match", () => {
    expect(matchByName("Ana M.", pros, (p) => p.names)?.id).toBe(3);
  });
  it("matches by words in any order", () => {
    const services = [{ n: "Corte de Cabello Mujer" }, { n: "Corte de Cabello Hombre" }, { n: "Masaje Relajante" }, { n: "Masaje Deportivo" }];
    expect(matchByName("Corte mujer", services, (s) => [s.n])?.n).toBe("Corte de Cabello Mujer");
    expect(matchByName("Corte", services, (s) => [s.n])).toBeNull();
    expect(matchByName("Masaje", services, (s) => [s.n])).toBeNull();
  });
});
