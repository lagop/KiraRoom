import { BadRequestException, ValidationPipe } from "@nestjs/common";
import ExcelJS from "exceljs";
import { ImportService } from "./import.service";
import { cellText, readXlsxRows } from "./spreadsheet";

/**
 * The importer only accepted CSV, so a salon whose previous program exports
 * Excel had to open the file and "save as CSV" first (on Windows, changing
 * its encoding on the way). An .xlsx is now read directly: its first sheet
 * becomes the same rows the CSV path produces, for clients, services and
 * appointments. Excel keeps dates, times and durations as numbers, so those
 * are what these files exercise. The files are generated here, small, with
 * fictitious data.
 */

type Cell = ExcelJS.CellValue | { value: ExcelJS.CellValue; numFmt: string };

async function xlsx(sheets: Cell[][][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  sheets.forEach((rows, i) => {
    const ws = wb.addWorksheet(`Hoja${i + 1}`);
    rows.forEach((row, r) =>
      row.forEach((cell, c) => {
        const target = ws.getCell(r + 1, c + 1);
        if (cell && typeof cell === "object" && "numFmt" in cell) {
          target.value = cell.value;
          target.numFmt = cell.numFmt;
        } else {
          target.value = cell as ExcelJS.CellValue;
        }
      }),
    );
  });
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** A time-of-day cell, as Excel stores "10:30" (day zero + the time). */
const time = (hh: number, mm: number, numFmt = "hh:mm") => ({ value: new Date(Date.UTC(1899, 11, 30, hh, mm)), numFmt });
const date = (y: number, m: number, d: number, hh = 0, mm = 0, numFmt = "dd/mm/yyyy") => ({
  value: new Date(Date.UTC(y, m - 1, d, hh, mm)),
  numFmt,
});

function prisma() {
  return {
    client: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({ id: `new-${data.firstName}` })),
      update: jest.fn(async () => ({})),
    },
    service: {
      findMany: jest.fn(async () => [
        { id: "s-corte", name: "Corte mujer", duration: 45, price: 25, currency: "EUR" },
      ]),
      create: jest.fn(async () => ({ id: "s-new" })),
      update: jest.fn(async () => ({})),
    },
    professional: { findMany: jest.fn(async () => [{ id: "p-carmen", firstName: "Carmen", lastName: "Sánchez" }]) },
    professionalLocation: { findMany: jest.fn(async () => []) },
    appointment: {
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => ({ id: "a1", ...data })),
    },
    tenant: { findUnique: jest.fn(async () => ({ country: "ES", timezone: "Europe/Madrid" })) },
    importJob: { create: jest.fn(async () => ({ id: "job1" })) },
  } as any;
}

describe("xlsx import", () => {
  it("reads clients: numeric phones, date cells, rich text", async () => {
    const file = await xlsx([
      [
        ["Nombre", "Apellidos", "Móvil", "Correo electrónico", "Fecha de nacimiento", "Observaciones"],
        ["Lucía", "Pérez Gil", 600112233, null, date(1990, 5, 12), { richText: [{ text: "Alergia " }, { text: "al látex" }] }],
        ["Marta", "Díaz", "611 22 33 44", { text: "marta@x.test", hyperlink: "mailto:marta@x.test" }, null, null],
        [null, null, null, null, null, null], // an empty row is not a row
      ],
    ]);
    const out: any = await new ImportService(prisma()).dryRunClients("t1", { xlsx: file }, "clientes.xlsx");
    expect(out.stats).toMatchObject({ totalRows: 2, okCount: 2, invalidCount: 0 });
    expect(out.preview[0].data).toMatchObject({
      firstName: "Lucía",
      lastName: "Pérez Gil",
      phone: "+34600112233",
      dateOfBirth: "1990-05-12",
      notes: "Alergia al látex",
    });
    expect(out.preview[1].data).toMatchObject({ phone: "+34611223344", email: "marta@x.test" });
  });

  it("reads services: durations as minutes or as times, prices as numbers or formulas", async () => {
    const file = await xlsx([
      [
        ["Servicio", "Duración", "Precio", "Categoría"],
        ["Masaje relajante", time(1, 30, "h:mm"), 60, ""],
        ["Manicura semipermanente", 45, { formula: "20+2", result: 22 }, "Uñas"],
        ["Corte niño", "30 min", 12.5, "Peluquería"],
      ],
    ]);
    const p = prisma();
    const out: any = await new ImportService(p).commitServices("t1", { xlsx: file }, "servicios.xlsx");
    expect(out).toMatchObject({ createdRows: 3, errorRows: 0 });
    const created = p.service.create.mock.calls.map((c: any) => c[0].data);
    expect(created.map((d: any) => [d.name, d.duration, Number(d.price), d.category])).toEqual([
      ["Masaje relajante", 90, 60, "massage"],
      ["Manicura semipermanente", 45, 22, "nails"],
      ["Corte niño", 30, 12.5, "hair"],
    ]);
  });

  it("reads appointments: one date-and-time cell, or a date cell and a time cell", async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000);
    const [y, m, d] = [soon.getUTCFullYear(), soon.getUTCMonth() + 1, soon.getUTCDate()];
    const iso = soon.toISOString().slice(0, 10);
    const together = await xlsx([
      [
        ["Fecha y hora", "Cliente", "Teléfono", "Servicio", "Profesional"],
        [date(y, m, d, 10, 30, "dd/mm/yyyy hh:mm"), "Eva Sanz", 600000001, "Corte mujer", "Carmen"],
      ],
    ]);
    const apart = await xlsx([
      [
        ["Fecha", "Hora", "Cliente", "Teléfono", "Servicio", "Profesional"],
        [date(y, m, d), time(17, 0), "Eva Sanz", 600000001, "Corte mujer", "Carmen"],
      ],
    ]);
    for (const [file, hhmm] of [[together, "10:30"], [apart, "17:00"]] as const) {
      const p = prisma();
      const out: any = await new ImportService(p).commitAppointments("t1", { xlsx: file }, "agenda.xlsx");
      expect(out).toMatchObject({ createdRows: 1, errorRows: 0 });
      const data = p.appointment.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ serviceId: "s-corte", professionalId: "p-carmen", scheduledTime: hhmm, totalAmount: 2500 });
      expect(data.scheduledDate.toISOString().slice(0, 10)).toBe(iso);
    }
  });

  it("reads only the first sheet, and names repeated headers like the CSV parser", async () => {
    const file = await xlsx([
      [
        ["Nombre", "Nombre", "", "Teléfono"],
        ["Ana", "Duplicada", "sin cabecera", 612345678],
      ],
      [["Otra hoja"], ["no se lee"]],
    ]);
    expect(await readXlsxRows(file)).toEqual([{ Nombre: "Ana", Nombre_1: "Duplicada", Teléfono: "612345678" }]);
  });

  it("refuses a file that is not an .xlsx, and an empty one, with a message the salon can act on", async () => {
    const svc = new ImportService(prisma());
    await expect(svc.dryRunClients("t1", { xlsx: Buffer.from("Nombre;Teléfono\nAna;600") }, "x.xlsx")).rejects.toThrow(
      /\.xls antiguo/,
    );
    await expect(svc.dryRunClients("t1", { xlsx: await xlsx([[["Nombre"]]]) }, "x.xlsx")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("turns cells into the text a CSV would have", () => {
    expect(cellText(25.499999999999996)).toBe("25.5");
    expect(cellText(new Date(Date.UTC(1899, 11, 30, 9, 59, 59, 990)))).toBe("10:00");
    expect(cellText(new Date(Date.UTC(2026, 9, 5)))).toBe("2026-10-05");
    expect(cellText({ error: "#N/A" } as any)).toBe("");
    expect(cellText(null)).toBe("");
  });
});

describe("xlsx request body", () => {
  // Both tests load the controller module (Nest decorators, ExcelJS): slow
  // to compile on a busy machine, well past Jest's default 5 s.
  jest.setTimeout(60_000);

  it("reaches the handler through the global ValidationPipe, as base64", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const { ImportController } = await import("./import.controller");
    const bodyType = Reflect.getMetadata("design:paramtypes", ImportController.prototype, "dryRunServices")[1];
    const file = await xlsx([[["Servicio", "Duración", "Precio"], ["Corte", 30, 15]]]);
    const body = await pipe.transform({ xlsx: file.toString("base64"), filename: "s.xlsx" }, { type: "body", metatype: bodyType });

    const service = { dryRunServices: jest.fn(async () => ({})) };
    await new ImportController(service as any).dryRunServices({ user: { tenantId: "t1" } } as any, body);
    const [, received, name] = (service.dryRunServices.mock.calls[0] as unknown) as [string, { xlsx: Buffer }, string];
    expect(Buffer.isBuffer(received.xlsx)).toBe(true);
    expect(received.xlsx.equals(file)).toBe(true);
    expect(name).toBe("s.xlsx");
  });

  it("rejects an xlsx field that is not base64, and a body with no file", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const { ImportController } = await import("./import.controller");
    const bodyType = Reflect.getMetadata("design:paramtypes", ImportController.prototype, "dryRun")[1];
    await expect(pipe.transform({ xlsx: "not base64!" }, { type: "body", metatype: bodyType })).rejects.toBeDefined();
    const empty = await pipe.transform({}, { type: "body", metatype: bodyType });
    await expect(new ImportController({} as any).dryRun({ user: { tenantId: "t1" } } as any, empty)).rejects.toThrow(
      /Falta el archivo/,
    );
  });
});
