import { Injectable } from "@nestjs/common";

/**
 * TicketBAI QR URLs. The VERI*FACTU QR is built in verifactu/qr.ts.
 */
@Injectable()
export class QrService {
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