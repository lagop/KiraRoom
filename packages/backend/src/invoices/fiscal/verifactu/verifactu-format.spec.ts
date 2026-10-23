import { validateAgainstXsd } from "./xsd.test";
import * as format from "./format";
import { altaHash, anulacionHash } from "./hash";
import { qrUrl } from "./qr";
import { parseResponse } from "./response";
import { AltaRecord, NS, SystemInstallation, regFactu, registroAlta, registroAnulacion } from "./xml";

/**
 * The parts of VERI*FACTU that must match the AEAT byte for byte: the
 * fingerprint (against the official worked examples), the XML (against the
 * official schemas, vendored in ./xsd), the QR URL and the response format.
 *
 * The previous implementation hashed "prevHash|nif|number|date|..." with a
 * pipe, used invented namespaces and a QR address that does not exist.
 */

// ---- Fingerprint: the official examples ------------------------------------

describe("huella (Especificaciones técnicas huella v0.1.2, worked examples)", () => {
  it("case 1: first alta record of the chain", () => {
    expect(
      altaHash({
        idEmisorFactura: "89890001K",
        numSerieFactura: "12345678/G33",
        fechaExpedicionFactura: "01-01-2024",
        tipoFactura: "F1",
        cuotaTotal: "12.35",
        importeTotal: "123.45",
        huellaAnterior: null,
        fechaHoraHusoGenRegistro: "2024-01-01T19:20:30+01:00",
      }),
    ).toBe("3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60");
  });

  it("case 2: second alta, chained to the first", () => {
    expect(
      altaHash({
        idEmisorFactura: "89890001K",
        numSerieFactura: "12345679/G34",
        fechaExpedicionFactura: "01-01-2024",
        tipoFactura: "F1",
        cuotaTotal: "12.35",
        importeTotal: "123.45",
        huellaAnterior: "3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60",
        fechaHoraHusoGenRegistro: "2024-01-01T19:20:35+01:00",
      }),
    ).toBe("F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97");
  });

  it("case 3: anulación, chained to the second", () => {
    expect(
      anulacionHash({
        idEmisorFacturaAnulada: "89890001K",
        numSerieFacturaAnulada: "12345679/G34",
        fechaExpedicionFacturaAnulada: "01-01-2024",
        huellaAnterior: "F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97",
        fechaHoraHusoGenRegistro: "2024-01-01T19:20:40+01:00",
      }),
    ).toBe("177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68");
  });

  it("AEAT's ejemploRegistro.xml: the hash is over the literal sent, so 41.4 and 41.40 differ", () => {
    const base = {
      idEmisorFactura: "89890001K",
      numSerieFactura: "12345678-G66",
      fechaExpedicionFactura: "03-02-2025",
      tipoFactura: "R3",
      huellaAnterior: "C9AF4AF1EF5EBBA700350DE3EEF12C2D355C56AC56F13DB2A25E0031BD2B7ED5",
      fechaHoraHusoGenRegistro: "2025-02-03T14:30:00+01:00",
    };
    expect(altaHash({ ...base, cuotaTotal: "41.4", importeTotal: "241.4" })).toBe(
      "FF954378B64ED331A9B2366AD317D86E9DEC1716B12DD0ACCB172A6DC4C105AA",
    );
    expect(altaHash({ ...base, cuotaTotal: "41.40", importeTotal: "241.40" })).not.toBe(
      "FF954378B64ED331A9B2366AD317D86E9DEC1716B12DD0ACCB172A6DC4C105AA",
    );
  });

  it("trims each value", () => {
    const fields = {
      idEmisorFactura: "89890001K",
      numSerieFactura: " 12345678/G33 ",
      fechaExpedicionFactura: "01-01-2024",
      tipoFactura: "F1",
      cuotaTotal: "12.35",
      importeTotal: "123.45",
      huellaAnterior: null,
      fechaHoraHusoGenRegistro: "2024-01-01T19:20:30+01:00",
    };
    expect(altaHash(fields)).toBe("3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60");
  });
});

// ---- Formats -----------------------------------------------------------------

describe("formats", () => {
  it("amounts always carry two decimals, with the sign in front", () => {
    expect(format.amount(1235)).toBe("12.35");
    expect(format.amount(5)).toBe("0.05");
    expect(format.amount(0)).toBe("0.00");
    expect(format.amount(-2550)).toBe("-25.50");
    expect(format.amount(10000000)).toBe("100000.00");
    expect(() => format.amount(12.5)).toThrow();
  });

  it("tax rates as the XSD wants them", () => {
    expect(format.rate(21)).toBe("21");
    expect(format.rate(9.5)).toBe("9.5");
    expect(format.rate(7.5)).toBe("7.5");
    expect(format.rate(0)).toBe("0");
  });

  it("FechaHoraHusoGenRegistro carries the salon's own offset, 25 characters", () => {
    const summer = new Date("2026-07-15T10:20:30Z");
    expect(format.generatedAt(summer, "Europe/Madrid")).toBe("2026-07-15T12:20:30+02:00");
    expect(format.generatedAt(summer, "Atlantic/Canary")).toBe("2026-07-15T11:20:30+01:00");
    const winter = new Date("2026-01-15T10:20:30Z");
    expect(format.generatedAt(winter, "Europe/Madrid")).toBe("2026-01-15T11:20:30+01:00");
    expect(format.generatedAt(winter, "Atlantic/Canary")).toBe("2026-01-15T10:20:30+00:00");
    expect(format.generatedAt(winter, "Europe/Madrid")).toHaveLength(25);
  });

  it("the expedition date is the salon's calendar day, not UTC's", () => {
    // 23:30 UTC on 31 December is already 1 January in Madrid.
    const instant = new Date("2026-12-31T23:30:00Z");
    expect(format.salonDate(instant, "Europe/Madrid")).toBe("01-01-2027");
    expect(format.salonYear(instant, "Europe/Madrid")).toBe(2027);
    expect(format.salonDate(instant, "Atlantic/Canary")).toBe("31-12-2026");
  });

  it("NIFs are normalised, and anything else is refused", () => {
    expect(format.nif("12345678-z")).toBe("12345678Z");
    expect(format.nif(" b 12.345.678 ")).toBe("B12345678");
    expect(format.nif("ESB12345678")).toBe("B12345678");
    expect(format.nif("1234")).toBeNull();
    expect(format.nif(null)).toBeNull();
  });

  it("invoice numbers AEAT would reject are caught before sending", () => {
    expect(format.invoiceNumber("A", "000123")).toBe("A000123");
    expect(() => format.invoiceNumber("A'", "1")).toThrow();
    expect(() => format.invoiceNumber("Ñ", "1")).toThrow();
    expect(() => format.invoiceNumber("A", "1".repeat(60))).toThrow();
  });
});

// ---- QR ----------------------------------------------------------------------

describe("QR URL (DetalleEspecificacTecnCodigoQRfactura v0.5.0)", () => {
  it("matches the official example, test environment", () => {
    expect(
      qrUrl({ nif: "89890001K", numSerie: "12345678&G33", fecha: "01-01-2024", importeTotal: "241.4" }, { VERIFACTU_ENV: "test" }),
    ).toBe("https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%26G33&fecha=01-01-2024&importe=241.4");
  });

  it("points at the real AEAT site only when production is chosen explicitly", () => {
    const url = qrUrl({ nif: "B12345678", numSerie: "A 000001", fecha: "02-10-2026", importeTotal: "25.00" }, {
      VERIFACTU_ENV: "production",
    });
    expect(url).toBe(
      "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345678&numserie=A+000001&fecha=02-10-2026&importe=25.00",
    );
    expect(qrUrl({ nif: "B12345678", numSerie: "A1", fecha: "02-10-2026", importeTotal: "1.00" }, {})).toMatch(/^https:\/\/prewww2\./);
  });
});

// ---- XML against the official schemas ----------------------------------------

const validate = validateAgainstXsd;

const system: SystemInstallation = {
  producer: { name: "Kira Studio Platform SL", nif: "B12345678" },
  installationNumber: "tenant-0001",
  userHasSeveralTaxpayers: false,
};
const salon = { name: "Salón Ñandú & Cía", nif: "12345678Z" };

function alta(overrides: Partial<AltaRecord> = {}): AltaRecord {
  return {
    refExterna: "rec-1",
    invoice: { nif: salon.nif, numSerie: "A000001", fecha: "02-10-2026" },
    issuerName: salon.name,
    tipoFactura: "F2",
    descripcion: "Corte mujer, Tinte <raíz>",
    desglose: [{ impuesto: "01", rate: "21", base: "20.66", cuota: "4.34" }],
    cuotaTotal: "4.34",
    importeTotal: "25.00",
    previous: null,
    system,
    generatedAt: "2026-10-02T10:15:00+02:00",
    huella: "A".repeat(64),
    ...overrides,
  };
}

describe("XML against the official XSD", () => {
  it("a first F2 (simplified) record", async () => {
    expect(await validate(regFactu(salon, [registroAlta(alta())], false, true), "SuministroLR.xsd")).toEqual([]);
  });

  it("an F1 with recipient, chained, two tax rates, under an incident", async () => {
    const xml = registroAlta(
      alta({
        tipoFactura: "F1",
        recipient: { name: "Empresa Cliente SL", nif: "B87654321" },
        desglose: [
          { impuesto: "01", rate: "21", base: "100.00", cuota: "21.00" },
          { impuesto: "01", rate: "10", base: "10.00", cuota: "1.00" },
        ],
        cuotaTotal: "22.00",
        importeTotal: "132.00",
        previous: { nif: salon.nif, numSerie: "A000000", fecha: "01-10-2026", huella: "B".repeat(64) },
      }),
    );
    expect(await validate(regFactu(salon, [xml], true, true), "SuministroLR.xsd")).toEqual([]);
  });

  it("an R5 rectificativa por diferencias with negative amounts, IGIC", async () => {
    const xml = registroAlta(
      alta({
        tipoFactura: "R5",
        tipoRectificativa: "I",
        rectified: [{ nif: salon.nif, numSerie: "A000001", fecha: "02-10-2026" }],
        desglose: [{ impuesto: "03", rate: "7", base: "-10.00", cuota: "-0.70" }],
        cuotaTotal: "-0.70",
        importeTotal: "-10.70",
        previous: { nif: salon.nif, numSerie: "A000001", fecha: "02-10-2026", huella: "C".repeat(64) },
      }),
    );
    expect(await validate(regFactu(salon, [xml], false, true), "SuministroLR.xsd")).toEqual([]);
  });

  it("a subsanación of a rejected alta, and an anulación sin registro previo, in one message", async () => {
    const sub = registroAlta(alta({ subsanacion: true, rechazoPrevio: "X" }));
    const anul = registroAnulacion({
      refExterna: "rec-3",
      invoice: { nif: salon.nif, numSerie: "A000002", fecha: "02-10-2026" },
      sinRegistroPrevio: true,
      previous: { nif: salon.nif, numSerie: "A000001", fecha: "02-10-2026", huella: "D".repeat(64) },
      system,
      generatedAt: "2026-10-02T10:20:00+02:00",
      huella: "E".repeat(64),
    });
    expect(await validate(regFactu(salon, [sub, anul], false, true), "SuministroLR.xsd")).toEqual([]);
    expect(sub).toContain("<sum1:Subsanacion>S</sum1:Subsanacion><sum1:RechazoPrevio>X</sum1:RechazoPrevio>");
  });

  it("escapes text: the salon's name and the descriptions", () => {
    const xml = registroAlta(alta());
    expect(xml).toContain("Salón Ñandú &amp; Cía");
    expect(xml).toContain("Tinte &lt;raíz&gt;");
  });

  it("the schema itself rejects a malformed record (the check is real)", async () => {
    const broken = registroAlta(alta()).replace("<sum1:TipoFactura>F2</sum1:TipoFactura>", "<sum1:TipoFactura>F9</sum1:TipoFactura>");
    expect((await validate(regFactu(salon, [broken], false, true), "SuministroLR.xsd")).length).toBeGreaterThan(0);
  });
});

// ---- Responses -----------------------------------------------------------------

const R = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaSuministro.xsd";

function respuesta(lines: string, estado = "ParcialmenteCorrecto", csv = "<tikR:CSV>A-ABCDEF0123456789</tikR:CSV>") {
  return (
    `<tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="${R}" xmlns:tik="${NS.sum1}">` +
    csv +
    `<tikR:DatosPresentacion><tik:NIFPresentador>12345678Z</tik:NIFPresentador><tik:TimestampPresentacion>2026-10-02T10:16:01+02:00</tik:TimestampPresentacion></tikR:DatosPresentacion>` +
    `<tikR:Cabecera><tik:ObligadoEmision><tik:NombreRazon>Salón</tik:NombreRazon><tik:NIF>12345678Z</tik:NIF></tik:ObligadoEmision></tikR:Cabecera>` +
    `<tikR:TiempoEsperaEnvio>60</tikR:TiempoEsperaEnvio>` +
    `<tikR:EstadoEnvio>${estado}</tikR:EstadoEnvio>` +
    lines +
    `</tikR:RespuestaRegFactuSistemaFacturacion>`
  );
}

const line = (num: string, estado: string, extra = "", op = "Alta") =>
  `<tikR:RespuestaLinea><tikR:IDFactura><tik:IDEmisorFactura>12345678Z</tik:IDEmisorFactura><tik:NumSerieFactura>${num}</tik:NumSerieFactura><tik:FechaExpedicionFactura>02-10-2026</tik:FechaExpedicionFactura></tikR:IDFactura>` +
  `<tikR:Operacion><tik:TipoOperacion>${op}</tik:TipoOperacion></tikR:Operacion><tikR:RefExterna>ref-${num}</tikR:RefExterna><tikR:EstadoRegistro>${estado}</tikR:EstadoRegistro>${extra}</tikR:RespuestaLinea>`;

const soap = (body: string) => `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body>${body}</env:Body></env:Envelope>`;

describe("AEAT responses", () => {
  const lines =
    line("A000001", "Correcto") +
    line("A000002", "AceptadoConErrores", "<tikR:CodigoErrorRegistro>2001</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>El NIF del destinatario no está identificado</tikR:DescripcionErrorRegistro>") +
    line("A000003", "Incorrecto", "<tikR:CodigoErrorRegistro>1100</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>Valor o tipo incorrecto</tikR:DescripcionErrorRegistro>") +
    line(
      "A000004",
      "Incorrecto",
      `<tikR:CodigoErrorRegistro>3000</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>Registro de facturación duplicado.</tikR:DescripcionErrorRegistro><tikR:RegistroDuplicado><tik:IdPeticionRegistroDuplicado>20261002101600</tik:IdPeticionRegistroDuplicado><tik:EstadoRegistroDuplicado>Correcta</tik:EstadoRegistroDuplicado></tikR:RegistroDuplicado>`,
    );

  it("the sample responses are valid against the official response schema", async () => {
    expect(await validate(respuesta(lines), "RespuestaSuministro.xsd")).toEqual([]);
  });

  it("reads the CSV, the wait, the overall state and every line", () => {
    const parsed = parseResponse(soap(respuesta(lines)));
    expect(parsed).toMatchObject({ kind: "response", csv: "A-ABCDEF0123456789", waitSeconds: 60, estadoEnvio: "ParcialmenteCorrecto" });
    if (parsed.kind !== "response") throw new Error();
    expect(parsed.lines.map((l) => [l.numSerie, l.estado, l.errorCode, l.duplicateState, l.refExterna])).toEqual([
      ["A000001", "Correcto", undefined, undefined, "ref-A000001"],
      ["A000002", "AceptadoConErrores", 2001, undefined, "ref-A000002"],
      ["A000003", "Incorrecto", 1100, undefined, "ref-A000003"],
      ["A000004", "Incorrecto", 3000, "Correcta", "ref-A000004"],
    ]);
  });

  it("a single line still comes back as a list", () => {
    const parsed = parseResponse(soap(respuesta(line("A000001", "Correcto"), "Correcto")));
    expect(parsed.kind === "response" && parsed.lines).toHaveLength(1);
  });

  it("a SOAP fault, client side, with its AEAT code (the official example)", () => {
    const fault = parseResponse(
      soap(
        `<env:Fault><faultcode>env:Client</faultcode><faultstring>Codigo[4104].El NIF del titular en la cabecera no está identificado. NIF:iii. NOMBRE_RAZON:xxx</faultstring><detail><callstack>x</callstack></detail></env:Fault>`,
      ),
    );
    expect(fault).toMatchObject({ kind: "fault", side: "Client", code: 4104 });
  });

  it("a server-side fault is told apart: it is resent as is", () => {
    expect(parseResponse(soap(`<env:Fault><faultcode>env:Server</faultcode><faultstring>Error interno</faultstring></env:Fault>`))).toMatchObject({
      kind: "fault",
      side: "Server",
    });
  });

  it("refuses anything that is not a SOAP answer", () => {
    expect(() => parseResponse("<html>Service Unavailable</html>")).toThrow();
  });
});
