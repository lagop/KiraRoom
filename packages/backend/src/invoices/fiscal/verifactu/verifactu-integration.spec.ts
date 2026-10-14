import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { InvoiceCalculator } from "../../invoice-calculator.service";
import { InvoiceService } from "../../invoices.service";
import { altaHash, anulacionHash } from "./hash";
import { VerifactuDispatcher } from "./verifactu-dispatcher.service";
import { VerifactuRecordsService } from "./verifactu-records.service";
import { NS, regFactu } from "./xml";
import { validateAgainstXsd } from "./xsd.test";

/**
 * VERI*FACTU against a real PostgreSQL with the migrations applied: the
 * chain, the per-salon lock, the immutability trigger, and the dispatcher
 * with an AEAT stand-in.
 *
 * Runs in CI (which provides a migrated database) or locally with
 * VERIFACTU_TEST_DATABASE_URL pointing at a throwaway one. Never against
 * DATABASE_URL outside CI: that is the developer's own database.
 */
const DB_URL = process.env.VERIFACTU_TEST_DATABASE_URL ?? (process.env.CI ? process.env.DATABASE_URL : undefined);
const describeDb = DB_URL ? describe : describe.skip;
// Real database round trips and schema validation: slower than a unit test,
// especially with the whole suite running in parallel.
jest.setTimeout(60_000);

const NIF = "12345678Z";

describeDb("VERI*FACTU with a database", () => {
  let prisma: PrismaClient;
  let records: VerifactuRecordsService;
  let invoices: InvoiceService;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.VERIFACTU_PRODUCER_NAME = "Kira Studio Platform SL";
    process.env.VERIFACTU_PRODUCER_NIF = "B12345678";
    process.env.VERIFACTU_ENV = "test";
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    records = new VerifactuRecordsService(prisma as any);
    const fiscal: any = { dispatchInvoice: jest.fn(async () => undefined), anulateInvoice: jest.fn(async () => true) };
    invoices = new InvoiceService(prisma as any, new InvoiceCalculator(), fiscal, undefined, records, undefined);
  });

  afterAll(async () => {
    process.env = savedEnv;
    await prisma.$disconnect();
  });

  async function salon(overrides: Record<string, unknown> = {}) {
    const id = randomUUID();
    await prisma.tenant.create({
      data: {
        id,
        name: `Salón Prueba ${id.slice(0, 8)}`,
        legalName: "Salón Prueba & Cía SL",
        slug: `vf-${id}`,
        plan: "esencial",
        subscriptionStatus: "active",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        taxId: NIF,
        timezone: "Europe/Madrid",
        fiscalMode: "verifactu",
        fiscalSettings: { defaultSeries: "A", taxRegime: "iva" },
        ...overrides,
      },
    });
    return id;
  }

  const issue = (tenantId: string, extra: Record<string, unknown> = {}, price = 2500) =>
    invoices.create({
      tenantId,
      recipientName: "Cliente final",
      lines: [{ description: "Corte mujer", quantity: 1, unitPriceCents: price, taxRate: 21 }],
      ...extra,
    } as any);

  const chainOf = (tenantId: string) => prisma.verifactuRecord.findMany({ where: { tenantId }, orderBy: { sequence: "asc" } });

  async function expectValidChain(tenantId: string) {
    const rows = await chainOf(tenantId);
    rows.forEach((r, i) => {
      expect(r.sequence).toBe(i + 1);
      expect(r.previousHash).toBe(i === 0 ? null : rows[i - 1].hash);
      const recomputed =
        r.kind === "alta"
          ? altaHash({
              idEmisorFactura: r.nif,
              numSerieFactura: r.numSerie,
              fechaExpedicionFactura: r.fecha,
              tipoFactura: r.tipoFactura!,
              cuotaTotal: r.cuotaTotal!,
              importeTotal: r.importeTotal!,
              huellaAnterior: r.previousHash,
              fechaHoraHusoGenRegistro: r.generatedAt,
            })
          : anulacionHash({
              idEmisorFacturaAnulada: r.nif,
              numSerieFacturaAnulada: r.numSerie,
              fechaExpedicionFacturaAnulada: r.fecha,
              huellaAnterior: r.previousHash,
              fechaHoraHusoGenRegistro: r.generatedAt,
            });
      expect(r.hash).toBe(recomputed);
      expect(r.xml).toContain(`<sum1:Huella>${r.hash}</sum1:Huella>`);
    });
    expect(await validateAgainstXsd(regFactu({ name: "Salón", nif: NIF }, rows.map((r) => r.xml), false, true), "SuministroLR.xsd")).toEqual([]);
    return rows;
  }

  it("records every invoice when it is issued, chained, with the AEAT QR", async () => {
    const tenantId = await salon();
    const first = await issue(tenantId);
    await issue(tenantId, { recipientName: "Empresa Cliente SL", recipientTaxId: "B-87654321" });

    const rows = await expectValidChain(tenantId);
    expect(rows.map((r) => [r.kind, r.tipoFactura, r.numSerie, r.importeTotal])).toEqual([
      ["alta", "F2", "A000001", "30.25"],
      ["alta", "F1", "A000002", "30.25"],
    ]);
    expect(rows[0].xml).toContain("<sum1:PrimerRegistro>S</sum1:PrimerRegistro>");
    expect(rows[1].xml).toContain("<sum1:NIF>B87654321</sum1:NIF>");
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: first.id } });
    expect(invoice).toMatchObject({ fiscalStatus: "pending", fiscalHash: rows[0].hash, issuerTaxIdAtIssue: NIF });
    expect(invoice.fiscalQrUrl).toMatch(/^https:\/\/prewww2\.aeat\.es\/wlpl\/TIKE-CONT\/ValidarQR\?nif=12345678Z&numserie=A000001&fecha=\d\d-\d\d-\d{4}&importe=30\.25$/);
  });

  it("does not issue what cannot be recorded, and does not use up its number", async () => {
    const tenantId = await salon();
    await issue(tenantId);
    // A factura simplificada over 3.000 € without the client's NIF.
    await expect(issue(tenantId, {}, 300_000)).rejects.toThrow(/3\.000/);
    const second = await issue(tenantId);
    const number = (await prisma.invoice.findUniqueOrThrow({ where: { id: second.id } })).number;
    expect(number).toBe("000002");
    expect(await prisma.invoice.count({ where: { tenantId } })).toBe(2);
    await expectValidChain(tenantId);
  });

  it("keeps the chain strictly sequential under concurrent invoicing", async () => {
    const tenantId = await salon();
    await Promise.all(Array.from({ length: 12 }, () => issue(tenantId)));
    const rows = await expectValidChain(tenantId);
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r.numSerie)).size).toBe(12);
  });

  it("annuls into the same chain, and rectifies with R1 / R5 referencing the original", async () => {
    const tenantId = await salon();
    const simplified = await issue(tenantId);
    const full = await issue(tenantId, { recipientName: "Empresa Cliente SL", recipientTaxId: "B87654321" });
    const wrong = await issue(tenantId);
    await invoices.anulate(tenantId, wrong.id, "Emitida por error");
    await invoices.emitRectification(tenantId, simplified.id, [{ description: "Devolución", quantity: 1, unitPriceCents: -500, taxRate: 21 }], "Devolución");
    await invoices.emitRectification(tenantId, full.id, [{ description: "Descuento", quantity: 1, unitPriceCents: -1000, taxRate: 21 }], "Descuento");

    const rows = await expectValidChain(tenantId);
    expect(rows.map((r) => [r.kind, r.tipoFactura, r.importeTotal])).toEqual([
      ["alta", "F2", "30.25"],
      ["alta", "F1", "30.25"],
      ["alta", "F2", "30.25"],
      ["anulacion", null, null],
      ["alta", "R5", "-6.05"],
      ["alta", "R1", "-12.10"],
    ]);
    expect(rows[3].numSerie).toBe(rows[2].numSerie);
    expect(rows[4].xml).toContain(
      `<sum1:FacturasRectificadas><sum1:IDFacturaRectificada><sum1:IDEmisorFactura>${NIF}</sum1:IDEmisorFactura><sum1:NumSerieFactura>${rows[0].numSerie}</sum1:NumSerieFactura>`,
    );
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: wrong.id } })).status).toBe("cancelled");
    // An invoice is annulled once.
    await expect(invoices.anulate(tenantId, wrong.id, "otra vez")).rejects.toThrow();
  });

  it("refuses, at the database, to change or delete a record", async () => {
    const tenantId = await salon();
    await issue(tenantId);
    const [row] = await chainOf(tenantId);
    await expect(prisma.verifactuRecord.update({ where: { id: row.id }, data: { importeTotal: "1.00" } })).rejects.toThrow(/cannot be changed/);
    await expect(prisma.verifactuRecord.delete({ where: { id: row.id } })).rejects.toThrow(/cannot be deleted/);
    await prisma.verifactuRecord.update({ where: { id: row.id }, data: { status: "accepted", csv: "A-TEST" } });
  });

  // ---- Submission ----------------------------------------------------------

  const R = NS.sum1.replace("SuministroInformacion.xsd", "RespuestaSuministro.xsd");
  function aeatAnswer(lines: Array<{ num: string; fecha: string; op?: string; ref?: string; estado: string; code?: number; dup?: string }>, wait = 60) {
    const estados = lines.map((l) => l.estado);
    const envio = estados.every((e) => e === "Correcto") ? "Correcto" : estados.every((e) => e === "Incorrecto") ? "Incorrecto" : "ParcialmenteCorrecto";
    return (
      `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body>` +
      `<tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="${R}" xmlns:tik="${NS.sum1}">` +
      `<tikR:CSV>A-CSV0000000000001</tikR:CSV>` +
      `<tikR:Cabecera><tik:ObligadoEmision><tik:NombreRazon>Salón</tik:NombreRazon><tik:NIF>${NIF}</tik:NIF></tik:ObligadoEmision></tikR:Cabecera>` +
      `<tikR:TiempoEsperaEnvio>${wait}</tikR:TiempoEsperaEnvio><tikR:EstadoEnvio>${envio}</tikR:EstadoEnvio>` +
      lines
        .map(
          (l) =>
            `<tikR:RespuestaLinea><tikR:IDFactura><tik:IDEmisorFactura>${NIF}</tik:IDEmisorFactura><tik:NumSerieFactura>${l.num}</tik:NumSerieFactura><tik:FechaExpedicionFactura>${l.fecha}</tik:FechaExpedicionFactura></tikR:IDFactura>` +
            `<tikR:Operacion><tik:TipoOperacion>${l.op ?? "Alta"}</tik:TipoOperacion></tikR:Operacion>` +
            (l.ref ? `<tikR:RefExterna>${l.ref}</tikR:RefExterna>` : "") +
            `<tikR:EstadoRegistro>${l.estado}</tikR:EstadoRegistro>` +
            (l.code ? `<tikR:CodigoErrorRegistro>${l.code}</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>Error ${l.code}</tikR:DescripcionErrorRegistro>` : "") +
            (l.dup ? `<tikR:RegistroDuplicado><tik:IdPeticionRegistroDuplicado>1</tik:IdPeticionRegistroDuplicado><tik:EstadoRegistroDuplicado>${l.dup}</tik:EstadoRegistroDuplicado></tikR:RegistroDuplicado>` : "") +
            `</tikR:RespuestaLinea>`,
        )
        .join("") +
      `</tikR:RespuestaRegFactuSistemaFacturacion></env:Body></env:Envelope>`
    );
  }

  function dispatcherWith(reply: (body: string) => Promise<{ status: number; body: string }>) {
    const sent: string[] = [];
    const transport: any = {
      post: jest.fn(async (url: string, body: string) => {
        sent.push(body);
        return reply(body);
      }),
    };
    const d = new VerifactuDispatcher(prisma as any, {} as any, transport);
    d.credentials = async () => ({ key: "k", cert: "c", type: "personal" });
    return { d, sent, transport };
  }

  const due = (tenantId: string) => prisma.verifactuChain.update({ where: { tenantId }, data: { nextSendAt: new Date(0) } });

  it("sends the queue in order, and records each record's result", async () => {
    const tenantId = await salon();
    const a = await issue(tenantId);
    const b = await issue(tenantId);
    const c = await issue(tenantId);
    const rows = await chainOf(tenantId);
    const { d, sent, transport } = dispatcherWith(async () => ({
      status: 200,
      body: aeatAnswer([
        { num: rows[0].numSerie, fecha: rows[0].fecha, ref: rows[0].id, estado: "Correcto" },
        { num: rows[1].numSerie, fecha: rows[1].fecha, ref: rows[1].id, estado: "AceptadoConErrores", code: 2001 },
        { num: rows[2].numSerie, fecha: rows[2].fecha, ref: rows[2].id, estado: "Incorrecto", code: 1100 },
      ], 90),
    }));

    expect(await d.sendNext(tenantId)).toMatchObject({ kind: "sent", accepted: 2, rejected: 1 });
    expect(transport.post.mock.calls[0][0]).toBe("https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP");
    // One message, the three records in order, valid against the schema.
    const body = /<soapenv:Body>([\s\S]*)<\/soapenv:Body>/.exec(sent[0])![1].replace(
      "<sum:RegFactuSistemaFacturacion>",
      `<sum:RegFactuSistemaFacturacion xmlns:sum="${NS.sum}" xmlns:sum1="${NS.sum1}">`,
    );
    expect(await validateAgainstXsd(body, "SuministroLR.xsd")).toEqual([]);
    expect(sent[0].indexOf(rows[0].hash)).toBeLessThan(sent[0].indexOf(rows[2].hash));
    expect(sent[0]).not.toContain("<sum1:Incidencia>");

    const after = await chainOf(tenantId);
    expect(after.map((r) => [r.status, r.errorCode, r.csv])).toEqual([
      ["accepted", null, "A-CSV0000000000001"],
      ["accepted_with_errors", 2001, "A-CSV0000000000001"],
      ["rejected", 1100, "A-CSV0000000000001"],
    ]);
    const inv = async (id: string) => prisma.invoice.findUniqueOrThrow({ where: { id } });
    expect(await inv(a.id)).toMatchObject({ fiscalStatus: "accepted", fiscalReference: "A-CSV0000000000001", fiscalError: null });
    expect((await inv(b.id)).fiscalError).toMatch(/^Aceptada con errores\. 2001/);
    expect(await inv(c.id)).toMatchObject({ fiscalStatus: "rejected" });

    // Flow control: the next submission waits what the AEAT said.
    const chain = await prisma.verifactuChain.findUniqueOrThrow({ where: { tenantId } });
    expect(chain.waitSeconds).toBe(90);
    expect(chain.nextSendAt.getTime() - Date.now()).toBeGreaterThan(80_000);
    expect(await d.sendNext(tenantId)).toEqual({ kind: "nothing" });
    expect(await prisma.verifactuSubmission.count({ where: { tenantId } })).toBe(1);

    // The rejected one is corrected with a new, chained record.
    await records.recordSubsanacion(tenantId, c.id);
    const fixed = await expectValidChain(tenantId);
    expect(fixed).toHaveLength(4);
    expect(fixed[3]).toMatchObject({ kind: "alta", subsanacion: true, numSerie: rows[2].numSerie, status: "pending" });
    expect(fixed[3].xml).toContain("<sum1:Subsanacion>S</sum1:Subsanacion><sum1:RechazoPrevio>X</sum1:RechazoPrevio>");
    expect(fixed[2].status).toBe("rejected"); // untouched
  });

  it("keeps invoicing through an outage, and flags the late records with Incidencia", async () => {
    const tenantId = await salon();
    await issue(tenantId);
    let up = false;
    const { d, sent } = dispatcherWith(async (body) => {
      if (!up) throw new Error("connect ETIMEDOUT");
      const nums = [...body.matchAll(/<sum1:NumSerieFactura>([^<]+)<\/sum1:NumSerieFactura><sum1:FechaExpedicionFactura>([^<]+)</g)];
      return { status: 200, body: aeatAnswer(nums.map((m) => ({ num: m[1], fecha: m[2], estado: "Correcto" }))) };
    });

    expect(await d.sendNext(tenantId)).toMatchObject({ kind: "unreachable" });
    let chain = await prisma.verifactuChain.findUniqueOrThrow({ where: { tenantId } });
    expect(chain.incidentSince).not.toBeNull();
    expect(chain.failedAttempts).toBe(1);
    expect(chain.lastError).toMatch(/ETIMEDOUT/);
    expect(chain.nextSendAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);

    // Invoicing goes on meanwhile.
    await issue(tenantId);
    expect((await chainOf(tenantId)).every((r) => r.status === "pending")).toBe(true);

    up = true;
    await due(tenantId);
    expect(await d.sendNext(tenantId)).toMatchObject({ kind: "sent", accepted: 2 });
    expect(sent[1]).toContain("<sum1:RemisionVoluntaria><sum1:Incidencia>S</sum1:Incidencia></sum1:RemisionVoluntaria>");
    chain = await prisma.verifactuChain.findUniqueOrThrow({ where: { tenantId } });
    expect(chain).toMatchObject({ incidentSince: null, failedAttempts: 0, lastError: null });
  });

  it("a rejected message (SOAP client fault) is not an incident: retried hourly, records kept", async () => {
    const tenantId = await salon();
    await issue(tenantId);
    const { d } = dispatcherWith(async () => ({
      status: 500,
      body: `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><env:Fault><faultcode>env:Client</faultcode><faultstring>Codigo[4112].El titular del certificado debe ser Obligado Emisión, Colaborador Social, Apoderado o Sucesor.</faultstring></env:Fault></env:Body></env:Envelope>`,
    }));
    expect(await d.sendNext(tenantId)).toMatchObject({ kind: "fault", side: "Client" });
    const chain = await prisma.verifactuChain.findUniqueOrThrow({ where: { tenantId } });
    expect(chain.incidentSince).toBeNull();
    expect(chain.lastError).toMatch(/4112/);
    expect(chain.nextSendAt.getTime() - Date.now()).toBeGreaterThan(3_500_000);
    expect((await chainOf(tenantId))[0].status).toBe("pending");
    expect(await prisma.verifactuSubmission.findFirst({ where: { tenantId } })).toMatchObject({ faultCode: 4112, httpStatus: 500 });
  });

  it("a record whose answer was lost and comes back as a duplicate counts as registered", async () => {
    const tenantId = await salon();
    await issue(tenantId);
    const [row] = await chainOf(tenantId);
    const { d } = dispatcherWith(async () => ({
      status: 200,
      body: aeatAnswer([{ num: row.numSerie, fecha: row.fecha, estado: "Incorrecto", code: 3000, dup: "Correcta" }]),
    }));
    await d.sendNext(tenantId);
    expect((await chainOf(tenantId))[0].status).toBe("accepted");
  });

  it("with no certificate, nothing is sent and the salon is told", async () => {
    const tenantId = await salon();
    await issue(tenantId);
    const transport: any = { post: jest.fn() };
    const d = new VerifactuDispatcher(prisma as any, {} as any, transport);
    delete process.env.VERIFACTU_PLATFORM_P12;
    expect(await d.sendNext(tenantId)).toEqual({ kind: "no-credentials" });
    expect(transport.post).not.toHaveBeenCalled();
    expect((await prisma.verifactuChain.findUniqueOrThrow({ where: { tenantId } })).lastError).toMatch(/certificado/);
  });
});
