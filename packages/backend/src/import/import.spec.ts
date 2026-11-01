import { ValidationPipe } from "@nestjs/common";
import { ImportService, mergeNotes } from "./import.service";
import { categoryFor, parseDate, parseDuration, parsePrice, parseYesNo, readClientRows } from "./columns";

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

describe("client import with action=update", () => {
  const existing = { id: "c1", email: "maria@x.test", phone: "+34612345678" };
  function db(notes: string | null) {
    const p = prisma([existing]);
    p.client.findFirst = jest.fn(async () => ({ notes }));
    return p;
  }

  it("an empty cell keeps her phone, birthday and notes", async () => {
    const p = db("Alergia al látex");
    await new ImportService(p).commitClients(
      "t1",
      "Nombre,Apellidos,Email,Teléfono,Fecha de nacimiento,Notas,action\nMaría,García,maria@x.test,,,,update\n",
      "t.csv",
    );
    const data = p.client.update.mock.calls[0][0].data;
    expect(data).toEqual({ firstName: "María", lastName: "García", email: "maria@x.test" });
  });

  it("adds the file's notes after hers instead of writing over them", async () => {
    const p = db("Alergia al látex");
    await new ImportService(p).commitClients(
      "t1",
      "Nombre,Email,Teléfono,Fecha de nacimiento,Notas,action\nMaría García,maria@x.test,600 11 22 33,12/05/1990,Prefiere las mañanas,update\n",
      "t.csv",
    );
    expect(p.client.findFirst).toHaveBeenCalledWith({ where: { id: "c1", tenantId: "t1" }, select: { notes: true } });
    expect(p.client.update.mock.calls[0][0].data).toMatchObject({
      phone: "+34600112233",
      dateOfBirth: new Date("1990-05-12"),
      notes: "Alergia al látex\n\nPrefiere las mañanas",
    });
  });

  it("does not repeat notes she already has", () => {
    expect(mergeNotes("Alergia al látex\n\nPrefiere las mañanas", "Prefiere las mañanas")).toBe(
      "Alergia al látex\n\nPrefiere las mañanas",
    );
    expect(mergeNotes(null, " Nueva ")).toBe("Nueva");
    expect(mergeNotes("Algo", "")).toBe("Algo");
    expect(mergeNotes(null, null)).toBeNull();
  });
});

describe("client import: the advertising column", () => {
  function withConsent(existingClients: any[] = []) {
    const p = prisma(existingClients);
    const consent = { recordMarketingChoice: jest.fn(async () => ({ status: "refused" })) };
    return { p, consent, service: new ImportService(p, consent as any) };
  }
  const CSV =
    "Nombre,Teléfono,Acepta publicidad\n" +
    "Lucía Pérez,600 11 22 33,No\n" +
    "Marta Díaz,611 22 33 44,Sí\n" +
    "Eva Gil,622 33 44 55,\n";

  it("reads the usual headers and values", () => {
    for (const header of ["Acepta publicidad", "LOPD", "Publicidad", "Comunicaciones comerciales", "Newsletter", "Acepta comunicaciones", "Marketing"]) {
      const [row] = readClientRows([{ Nombre: "Ana", [header]: "no" }]);
      expect(row.marketing).toBe("no");
    }
    expect(["no", "NO", "N", "false", "0", "No acepta", "Rechaza", "baja"].map(parseYesNo)).toEqual(Array(8).fill("no"));
    expect(["sí", "Si", "S", "x", "yes", "TRUE", "1", "Acepta"].map(parseYesNo)).toEqual(Array(8).fill("yes"));
    expect(["", "pendiente", "?"].map(parseYesNo)).toEqual([undefined, undefined, undefined]);
  });

  it("records a 'no' as the client's refusal, recorded by whoever imported; a 'sí' records nothing", async () => {
    const { p, consent, service } = withConsent();
    const out: any = await service.commitClients("t1", CSV, "export.csv", "user-1");

    expect(p.client.create).toHaveBeenCalledTimes(3);
    expect(consent.recordMarketingChoice).toHaveBeenCalledTimes(1);
    expect(consent.recordMarketingChoice).toHaveBeenCalledWith({
      tenantId: "t1",
      clientId: "new-Lucía",
      accepts: false,
      channel: "email",
      recordedBy: "user-1",
    });
    expect(out.marketingRefusals).toBe(1);
  });

  it("the preview says so and records nothing", async () => {
    const { consent, service } = withConsent();
    const out: any = await service.dryRunClients("t1", CSV, "export.csv");
    expect(out.preview.map((r: any) => r.note)).toEqual(["No acepta publicidad: se guardará en su ficha", undefined, undefined]);
    expect(consent.recordMarketingChoice).not.toHaveBeenCalled();
  });

  it("records the refusal of a client the salon already has, without changing anything else", async () => {
    const { p, consent, service } = withConsent([{ id: "c-lucia", email: null, phone: "+34600112233" }]);
    await service.commitClients("t1", CSV, "export.csv", "user-1");
    expect(p.client.update).not.toHaveBeenCalled();
    expect(consent.recordMarketingChoice).toHaveBeenCalledWith(expect.objectContaining({ clientId: "c-lucia", accepts: false }));
  });

  it("a failure to record it does not stop the import", async () => {
    const { consent, service } = withConsent();
    consent.recordMarketingChoice.mockRejectedValueOnce(new Error("db down"));
    const out: any = await service.commitClients("t1", CSV, "export.csv", "user-1");
    expect(out).toMatchObject({ createdRows: 3, errorRows: 0, marketingRefusals: 0 });
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
