import { SYSTEM, Producer } from "./config";
import { xmlText } from "./format";
import type { OperationCode } from "./zero-rate";

/**
 * VERI*FACTU XML, element by element in the order of the official schemas
 * (SuministroLR.xsd, SuministroInformacion.xsd). Values arrive already
 * formatted (format.ts); this file only escapes and places them.
 *
 * Records are built as fragments with the sum1 prefix and kept as such;
 * the envelope declares the namespaces when they are sent.
 */

export const NS = {
  soapenv: "http://schemas.xmlsoap.org/soap/envelope/",
  sum: "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd",
  sum1: "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd",
} as const;

export interface Party {
  name: string;
  nif: string;
}

/**
 * IDOtro: a recipient without a Spanish NIF. IDType 02 is the NIF-IVA of
 * another EU country; the other types are not generated (format.recipientId).
 */
export interface ForeignId {
  /** CodigoPais (CountryType2). */
  country: string;
  idType: "02";
  id: string;
}

export type Recipient = { name: string } & ({ nif: string } | { otro: ForeignId });

export interface InvoiceId {
  nif: string;
  numSerie: string;
  /** dd-mm-yyyy */
  fecha: string;
}

export interface TaxLine {
  /** 01 IVA, 02 IPSI (Ceuta y Melilla), 03 IGIC (Canarias). */
  impuesto: "01" | "02" | "03";
  /** Left out: S1. Only 0 % lines take another one (zero-rate.ts). */
  operation?: OperationCode;
  rate: string;
  base: string;
  cuota: string;
}

/** The previous record of the chain, or null for the first. */
export type PreviousRecord = (InvoiceId & { huella: string }) | null;

export interface SystemInstallation {
  producer: Producer;
  /** NumeroInstalacion: never repeated for the same taxpayer. */
  installationNumber: string;
  /** IndicadorMultiplesOT for this user: whether they run more than one billing. */
  userHasSeveralTaxpayers: boolean;
}

export interface AltaRecord {
  refExterna: string;
  invoice: InvoiceId;
  issuerName: string;
  /** Subsanación of a record the AEAT rejected or never received. */
  subsanacion?: boolean;
  rechazoPrevio?: "N" | "S" | "X";
  tipoFactura: "F1" | "F2" | "R1" | "R4" | "R5";
  /** Only for R*: always "I" (por diferencias) here. */
  tipoRectificativa?: "I";
  rectified?: InvoiceId[];
  descripcion: string;
  /** FacturaSimplificadaArt7273: a simplified invoice that names its recipient (RD 1619/2012 art. 7.2), sent as F1. */
  simplifiedWithRecipient?: boolean;
  /** Mandatory for F1 and R1-R4, forbidden for F2 and R5. */
  recipient?: Recipient;
  desglose: TaxLine[];
  cuotaTotal: string;
  importeTotal: string;
  previous: PreviousRecord;
  system: SystemInstallation;
  generatedAt: string;
  huella: string;
}

export interface AnulacionRecord {
  refExterna: string;
  invoice: InvoiceId;
  /** The AEAT holds no alta of this invoice. */
  sinRegistroPrevio?: boolean;
  /** A previous anulación of this invoice was rejected by the AEAT. */
  rechazoPrevio?: boolean;
  previous: PreviousRecord;
  system: SystemInstallation;
  generatedAt: string;
  huella: string;
}

const el = (name: string, value: string) => `<sum1:${name}>${xmlText(value)}</sum1:${name}>`;
const wrap = (name: string, inner: string) => `<sum1:${name}>${inner}</sum1:${name}>`;

function encadenamiento(previous: PreviousRecord): string {
  if (!previous) return wrap("Encadenamiento", el("PrimerRegistro", "S"));
  return wrap(
    "Encadenamiento",
    wrap(
      "RegistroAnterior",
      el("IDEmisorFactura", previous.nif) +
        el("NumSerieFactura", previous.numSerie) +
        el("FechaExpedicionFactura", previous.fecha) +
        el("Huella", previous.huella),
    ),
  );
}

function sistemaInformatico(s: SystemInstallation): string {
  return wrap(
    "SistemaInformatico",
    el("NombreRazon", s.producer.name) +
      el("NIF", s.producer.nif) +
      el("NombreSistemaInformatico", SYSTEM.name) +
      el("IdSistemaInformatico", SYSTEM.id) +
      el("Version", SYSTEM.version) +
      el("NumeroInstalacion", s.installationNumber) +
      el("TipoUsoPosibleSoloVerifactu", SYSTEM.onlyVerifactu ? "S" : "N") +
      el("TipoUsoPosibleMultiOT", SYSTEM.multipleTaxpayers ? "S" : "N") +
      el("IndicadorMultiplesOT", s.userHasSeveralTaxpayers ? "S" : "N"),
  );
}

/** One line of the Desglose. Exempt and not-subject lines carry no rate and no cuota. */
function detalleDesglose(t: TaxLine): string {
  const code = t.operation ?? "S1";
  const taxed = code === "S1";
  return wrap(
    "DetalleDesglose",
    el("Impuesto", t.impuesto) +
      el("ClaveRegimen", "01") +
      el(code.startsWith("E") ? "OperacionExenta" : "CalificacionOperacion", code) +
      (taxed ? el("TipoImpositivo", t.rate) : "") +
      el("BaseImponibleOimporteNoSujeto", t.base) +
      (taxed ? el("CuotaRepercutida", t.cuota) : ""),
  );
}

function idDestinatario(r: Recipient): string {
  const id =
    "nif" in r
      ? el("NIF", r.nif)
      : wrap("IDOtro", el("CodigoPais", r.otro.country) + el("IDType", r.otro.idType) + el("ID", r.otro.id));
  return wrap("IDDestinatario", el("NombreRazon", r.name) + id);
}

export function registroAlta(r: AltaRecord): string {
  const isRectificativa = r.tipoFactura.startsWith("R");
  return wrap(
    "RegistroAlta",
    el("IDVersion", "1.0") +
      wrap(
        "IDFactura",
        el("IDEmisorFactura", r.invoice.nif) +
          el("NumSerieFactura", r.invoice.numSerie) +
          el("FechaExpedicionFactura", r.invoice.fecha),
      ) +
      el("RefExterna", r.refExterna) +
      el("NombreRazonEmisor", r.issuerName) +
      (r.subsanacion ? el("Subsanacion", "S") : "") +
      (r.subsanacion && r.rechazoPrevio && r.rechazoPrevio !== "N" ? el("RechazoPrevio", r.rechazoPrevio) : "") +
      el("TipoFactura", r.tipoFactura) +
      (isRectificativa ? el("TipoRectificativa", r.tipoRectificativa ?? "I") : "") +
      (isRectificativa && r.rectified?.length
        ? wrap(
            "FacturasRectificadas",
            r.rectified
              .map((f) =>
                wrap(
                  "IDFacturaRectificada",
                  el("IDEmisorFactura", f.nif) + el("NumSerieFactura", f.numSerie) + el("FechaExpedicionFactura", f.fecha),
                ),
              )
              .join(""),
          )
        : "") +
      el("DescripcionOperacion", r.descripcion) +
      (r.simplifiedWithRecipient ? el("FacturaSimplificadaArt7273", "S") : "") +
      (r.recipient ? wrap("Destinatarios", idDestinatario(r.recipient)) : "") +
      wrap("Desglose", r.desglose.map(detalleDesglose).join("")) +
      el("CuotaTotal", r.cuotaTotal) +
      el("ImporteTotal", r.importeTotal) +
      encadenamiento(r.previous) +
      sistemaInformatico(r.system) +
      el("FechaHoraHusoGenRegistro", r.generatedAt) +
      el("TipoHuella", "01") +
      el("Huella", r.huella),
  );
}

export function registroAnulacion(r: AnulacionRecord): string {
  return wrap(
    "RegistroAnulacion",
    el("IDVersion", "1.0") +
      wrap(
        "IDFactura",
        el("IDEmisorFacturaAnulada", r.invoice.nif) +
          el("NumSerieFacturaAnulada", r.invoice.numSerie) +
          el("FechaExpedicionFacturaAnulada", r.invoice.fecha),
      ) +
      el("RefExterna", r.refExterna) +
      (r.sinRegistroPrevio ? el("SinRegistroPrevio", "S") : "") +
      (r.rechazoPrevio ? el("RechazoPrevio", "S") : "") +
      encadenamiento(r.previous) +
      sistemaInformatico(r.system) +
      el("FechaHoraHusoGenRegistro", r.generatedAt) +
      el("TipoHuella", "01") +
      el("Huella", r.huella),
  );
}

/**
 * The SOAP message for one submission: one taxpayer, 1 to 1000 records in
 * the order they were generated. `incidencia` tells the AEAT the records
 * are late because of a technical incident (Orden HAC/1177/2024 art. 16.4).
 */
export function envelope(obligado: Party, records: string[], incidencia: boolean): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="${NS.soapenv}" xmlns:sum="${NS.sum}" xmlns:sum1="${NS.sum1}">` +
    `<soapenv:Header/><soapenv:Body>` +
    regFactu(obligado, records, incidencia) +
    `</soapenv:Body></soapenv:Envelope>`
  );
}

/**
 * The RegFactuSistemaFacturacion element. With `declareNamespaces` it is a
 * document of its own, which is what the schema validates in the tests.
 */
export function regFactu(obligado: Party, records: string[], incidencia: boolean, declareNamespaces = false): string {
  if (records.length < 1 || records.length > 1000) throw new Error(`A submission holds 1-1000 records, not ${records.length}`);
  const ns = declareNamespaces ? ` xmlns:sum="${NS.sum}" xmlns:sum1="${NS.sum1}"` : "";
  const cabecera =
    `<sum:Cabecera>` +
    wrap("ObligadoEmision", el("NombreRazon", obligado.name) + el("NIF", obligado.nif)) +
    (incidencia ? wrap("RemisionVoluntaria", el("Incidencia", "S")) : "") +
    `</sum:Cabecera>`;
  return (
    `<sum:RegFactuSistemaFacturacion${ns}>` +
    cabecera +
    records.map((r) => `<sum:RegistroFactura>${r}</sum:RegistroFactura>`).join("") +
    `</sum:RegFactuSistemaFacturacion>`
  );
}
