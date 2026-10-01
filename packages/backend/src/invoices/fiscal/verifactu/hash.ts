import { createHash } from "crypto";

/**
 * The record fingerprint ("huella"), per the AEAT document "Especificaciones
 * técnicas para la generación de la huella o hash de los registros de
 * facturación" (v0.1.2) and Orden HAC/1177/2024 art. 13.
 *
 *   campo1=valor1&campo2=valor2&...   (fixed field names, in this order)
 *   each value trimmed; an empty value is written as "campo=" with nothing after
 *   SHA-256 over the UTF-8 bytes, 64 upper-case hex characters
 *
 * The values must be the exact strings sent in the XML (see format.ts).
 */
function fingerprint(fields: Array<[string, string | null | undefined]>): string {
  const message = fields.map(([name, value]) => `${name}=${value == null ? "" : value.trim()}`).join("&");
  return createHash("sha256").update(message, "utf8").digest("hex").toUpperCase();
}

export interface AltaHashFields {
  idEmisorFactura: string;
  numSerieFactura: string;
  fechaExpedicionFactura: string;
  tipoFactura: string;
  cuotaTotal: string;
  importeTotal: string;
  /** Huella of the previous record in the chain; null for the first one. */
  huellaAnterior: string | null;
  fechaHoraHusoGenRegistro: string;
}

export function altaHash(f: AltaHashFields): string {
  return fingerprint([
    ["IDEmisorFactura", f.idEmisorFactura],
    ["NumSerieFactura", f.numSerieFactura],
    ["FechaExpedicionFactura", f.fechaExpedicionFactura],
    ["TipoFactura", f.tipoFactura],
    ["CuotaTotal", f.cuotaTotal],
    ["ImporteTotal", f.importeTotal],
    ["Huella", f.huellaAnterior],
    ["FechaHoraHusoGenRegistro", f.fechaHoraHusoGenRegistro],
  ]);
}

export interface AnulacionHashFields {
  idEmisorFacturaAnulada: string;
  numSerieFacturaAnulada: string;
  fechaExpedicionFacturaAnulada: string;
  huellaAnterior: string | null;
  fechaHoraHusoGenRegistro: string;
}

export function anulacionHash(f: AnulacionHashFields): string {
  return fingerprint([
    ["IDEmisorFacturaAnulada", f.idEmisorFacturaAnulada],
    ["NumSerieFacturaAnulada", f.numSerieFacturaAnulada],
    ["FechaExpedicionFacturaAnulada", f.fechaExpedicionFacturaAnulada],
    ["Huella", f.huellaAnterior],
    ["FechaHoraHusoGenRegistro", f.fechaHoraHusoGenRegistro],
  ]);
}
