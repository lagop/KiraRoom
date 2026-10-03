import { qrBase } from "./config";

/**
 * The URL printed as a QR code on every VERI*FACTU invoice, so whoever
 * receives it can check it at the AEAT (DetalleEspecificacTecnCodigoQRfactura
 * v0.5.0 §5-6): nif, numserie, fecha (dd-mm-yyyy) and importe (ImporteTotal),
 * in that order.
 *
 * Encoded like the official Java sample (URLEncoder, UTF-8): URLSearchParams
 * does the same; encodeURIComponent does not (it writes spaces as %20).
 */
export function qrUrl(
  input: { nif: string; numSerie: string; fecha: string; importeTotal: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  const params = new URLSearchParams({
    nif: input.nif,
    numserie: input.numSerie,
    fecha: input.fecha,
    importe: input.importeTotal,
  });
  return `${qrBase(env)}?${params.toString()}`;
}
