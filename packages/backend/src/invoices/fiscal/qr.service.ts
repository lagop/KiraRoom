import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";

export interface VerifactuQrInput {
  nif: string;
  invoiceNumber: string;
  issueDate: string; // YYYY-MM-DD
  totalCents: number;
}

/**
 * Verifactu QR builder.
 *
 * The AEAT spec (Real Decreto 1007/2023) requires a specific URL shape that
 * encodes NIF + number + date + amount so that anyone scanning the printed
 * QR can verify the invoice at:
 *   https://www2.agenciatributaria.gob.es/wlpl/inwinvoc/es.aeat.dit.adu.inwinvoc.JDetalleInvoc
 *
 * The query string is hashed and base64url-encoded. We build the canonical
 * URL here without depending on any AEAT API.
 */
@Injectable()
export class QrService {
  /**
   * Build the full QR URL that is printed on Verifactu invoices.
   */
  buildVerifactuUrl(input: VerifactuQrInput): string {
    const canonical = [
      "nif=" + input.nif,
      "numserie=" + input.invoiceNumber,
      "fecha=" + input.issueDate,
      "importe=" + (input.totalCents / 100).toFixed(2),
    ].join("&");
    const hash = createHash("sha256").update(canonical).digest("hex");
    const base =
      "https://www2.agenciatributaria.gob.es/wlpl/inwinvoc/es.aeat.dit.adu.inwinvoc.JDetalleInvoc";
    return `${base}?${canonical}&hash=${hash.slice(0, 16)}`;
  }

  /**
   * For TicketBAI the QR points to the deputación verifier with the TBAI
   * code as identifier. The URL shape differs per deputación:
   *   - Bizkaia: https://www.batuz.eus/QRTBAI/?tbai=<code>
   *   - Gipuzkoa: https://tbai.gipuzkoa.eus/qr/?tbai=<code>
   *   - Álava:   https://tbai.araba.eus/qr/?tbai=<code>
   */
  buildTicketBaiUrl(
    diputacion: "bizkaia" | "gipuzkoa" | "alava",
    tbaiCode: string,
  ): string {
    const map = {
      bizkaia: "https://www.batuz.eus/QRTBAI/",
      gipuzkoa: "https://tbai.gipuzkoa.eus/qr/",
      alava: "https://tbai.araba.eus/qr/",
    };
    return `${map[diputacion]}?tbai=${encodeURIComponent(tbaiCode)}`;
  }
}