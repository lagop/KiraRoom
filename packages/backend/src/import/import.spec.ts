import { ValidationPipe } from "@nestjs/common";
import { ImportService } from "./import.service";
import { categoryFor, parseDate, parseDuration, parsePrice } from "./columns";

/**
 * The importer only read its own template, required an email and an E.164
 * phone, and -- because its body class had no validators -- never received
 * the file at all. It now reads other programs' exports.
 */
function prisma(existingClients: any[] = [], existingServices: any[] = []) {
  return {
    client: {
      findMany: jest.fn(async () => existingClients),
      create: jest.fn(async ({ data }: any) => ({ id: `new-${data.firstName}` })),
      update: jest.fn(async () => ({})),
    },
    service: {
      findMany: jest.fn(async () => existingServices),
      create: jest.fn(async () => ({ id: "s-new" })),
      update: jest.fn(async () => ({})),
    },
    tenant: { findUnique: jest.fn(async () => ({ country: "ES" })) },
    importJob: { create: jest.fn(async () => ({ id: "job1" })) },
  } as any;
}

// A Spanish Excel export: BOM, semicolons, accented headers, local phones, dd/mm/yyyy.
const EXCEL = "﻿Nombre;Apellidos;Móvil;Correo electrónico;Fecha de nacimiento;Observaciones\n" +
  "Lucía;Pérez Gil;600 11 22 33;;12/05/1990;Alergia al látex\n" +
  "Marta;Díaz;611-22-33-44;marta@x.test;;\n" +
  "Lucía;Pérez;+34 600 112 233;;;\n" + // same phone as row 2 of the file
  "Sin;Contacto;;;;\n";

describe("client import", () => {
  it("reads a Spanish export: headers, local phones, dates, optional email", async () => {
    const service = new ImportService(prisma());
    const out: any = await service.dryRunClients("t1", EXCEL, "export.csv");
    expect(out.stats).toEqual({ totalRows: 4, okCount: 2, updateCount: 0, duplicateCount: 1, invalidCount: 1, skipCount: 0 });
    expect(out.preview[0].data).toMatchObject({
      firstName: "Lucía",
      lastName: "Pérez Gil",
      phone: "+34600112233",
      dateOfBirth: "1990-05-12",
      notes: "Alergia al látex",
    });
    expect(out.preview[0].data.email).toBeUndefined();
    expect(out.preview[3].errors[0].msg).toMatch(/teléfono o un email/);
  });

  it("does not duplicate a client the salon already has, matched by phone", async () => {
    const p = prisma([{ id: "c1", email: null, phone: "600112233" }]);
    const out: any = await new ImportService(p).commitClients("t1", EXCEL, "export.csv");
    expect(p.client.create).toHaveBeenCalledTimes(1); // only Marta
    expect(p.client.create.mock.calls[0][0].data).toMatchObject({ firstName: "Marta", phone: "+34611223344", email: "marta@x.test" });
    expect(out).toMatchObject({ createdRows: 1, skippedRows: 2, errorRows: 1 });
  });

  it("splits a single full-name column", async () => {
    const out: any = await new ImportService(prisma()).dryRunClients(
      "t1",
      "Cliente,Teléfono\nAna María Ruiz Soler,612345678\n",
      "booksy.csv",
    );
    expect(out.preview[0].data).toMatchObject({ firstName: "Ana", lastName: "María Ruiz Soler" });
  });

  it("still reads KiraRoom's old English template", async () => {
    const out: any = await new ImportService(prisma()).dryRunClients(
      "t1",
      "firstName,lastName,email,phone\nMaría,García,maria@example.com,+34612345678\n",
      "t.csv",
    );
    expect(out.stats.okCount).toBe(1);
  });
});

describe("service import", () => {
  const CSV = "Servicio;Duración;Precio;Categoría\n" +
    "Corte mujer;45 min;25,50 €;Peluquería\n" +
    "Manicura semipermanente;1 h;22;\n" +
    "Masaje relajante;1:30;€ 60;\n" +
    "Sin precio;30;;\n";

  it("reads durations, prices and categories, and updates services that exist", async () => {
    const p = prisma([], [{ id: "s1", name: "Corte Mujer" }]);
    const out: any = await new ImportService(p).commitServices("t1", CSV, "servicios.csv");
    expect(p.service.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: expect.objectContaining({ duration: 45, category: "hair" }),
    });
    expect(Number(p.service.update.mock.calls[0][0].data.price)).toBe(25.5);
    const created = p.service.create.mock.calls.map((c: any) => c[0].data);
    expect(created.map((d: any) => [d.name, d.duration, Number(d.price), d.category])).toEqual([
      ["Manicura semipermanente", 60, 22, "nails"],
      ["Masaje relajante", 90, 60, "massage"],
    ]);
    expect(out).toMatchObject({ createdRows: 2, updatedRows: 1, errorRows: 1 });
  });
});

describe("parsers", () => {
  it("dates", () => {
    expect(parseDate("31/12/1999")).toBe("1999-12-31");
    expect(parseDate("1999-12-31")).toBe("1999-12-31");
    expect(parseDate("31.12.99")).toBe("1999-12-31");
    expect(parseDate("31/02/2000")).toBeUndefined();
  });
  it("durations", () => {
    expect(parseDuration("1 h 30 min")).toBe(90);
    expect(parseDuration("90'")).toBe(90);
    expect(parseDuration("1,5 h")).toBe(90);
    expect(parseDuration("abc")).toBeUndefined();
  });
  it("prices", () => {
    expect(parsePrice("1.200,00 €")).toBe(1200);
    expect(parsePrice("12.5")).toBe(12.5);
    expect(parsePrice("")).toBeUndefined();
  });
  it("categories", () => {
    expect(categoryFor("Depilación cera piernas")).toBe("body");
    expect(categoryFor("Diseño de cejas")).toBe("facial");
    expect(categoryFor("Bono regalo")).toBe("other");
  });
});

describe("import request body", () => {
  it("reaches the handler through the global ValidationPipe", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true });
    const { ImportController } = await import("./import.controller");
    const bodyType = Reflect.getMetadata("design:paramtypes", ImportController.prototype, "dryRun")[1];
    const body = await pipe.transform({ csv: "a,b\n1,2", filename: "x.csv" }, { type: "body", metatype: bodyType });
    expect(body.csv).toBe("a,b\n1,2");
  });
});
