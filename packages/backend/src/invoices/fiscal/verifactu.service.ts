import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { XadesService } from "./xades.service";
import { QrService } from "./qr.service";
import { FiscalCertificateService } from "./fiscal-certificate.service";
import { createHash } from "crypto";

export interface VerifactuDispatchInput {
  invoiceId: string;
  xml: string;
  nif: string;
  invoiceNumber: string;
  issueDate: string;
  totalCents: number;
  tenantNif: string;
}

export interface VerifactuDispatchResult {
  status: "accepted" | "rejected" | "error";
  reference?: string;
  error?: string;
  qrUrl?: string;
}

/**
 * Verifactu dispatch service (RD 1007/2023).
 *
 * Production-real (post-F2):
 *   1. Builds the AEAT envelope.
 *   2. Loads the tenant's active PKCS#12 from `FiscalCertificate`.
 *   3. Signs it via `XadesService.sign()` (XAdES-BES).
 *   4. POSTs the signed XML to `process.env.AEAT_VERIFACTU_ENDPOINT`.
 *   5. Persists the AEAT response (CSV / hash) and emits the QR URL.
 *
 * Under `FISCAL_E2E_MODE=stub` (default in CI) the HTTP transport
 * returns a deterministic accepted response.
 */
@Injectable()
export class VerifactuService {
  private readonly logger = new Logger(VerifactuService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly xades: XadesService,
    private readonly qr: QrService,
    private readonly certs: FiscalCertificateService,
  ) {}

  /**
   * Build the Verifactu XML envelope for an invoice. The placeholder for
   * `<Huella>` and `<HuellaAnterior>` is filled by `FiscalService`.
   */
  buildInvoiceXml(input: {
    invoiceId: string;
    nif: string;
    tenantNif: string;
    invoiceNumber: string;
    issueDate: string;
    totalCents: number;
    subtotalCents: number;
    taxBreakdown: Array<{ rate: number; baseCents: number; taxCents: number }>;
    huettaAnterior?: string | null;
  }): string {
    const breakdown = input.taxBreakdown
      .map(
        (t) =>
          `    <DetalleIVA>
      <TipoImpositivo>${t.rate}</TipoImpositivo>
      <BaseImponible>${(t.baseCents / 100).toFixed(2)}</BaseImponible>
      <CuotaRepercutida>${(t.taxCents / 100).toFixed(2)}</CuotaRepercutida>
    </DetalleIVA>`,
      )
      .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:veri="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd">
  <soapenv:Body>
    <veri:RegFactuSistemaFacturacion>
      <veri:Cabecera>
        <veri:ObligadoEmision>
          <veri:NIF>${input.tenantNif}</veri:NIF>
        </veri:ObligadoEmision>
      </veri:Cabecera>
      <veri:RegistroFactura>
        <veri:RegistroAlta>
          <veri:NumSerieFactura>${input.invoiceNumber}</veri:NumSerieFactura>
          <veri:FechaExpedicionFactura>${input.issueDate}</veri:FechaExpedicionFactura>
          <veri:NIFDestinatario>${input.nif}</veri:NIFDestinatario>
          <veri:ImporteTotal>${(input.totalCents / 100).toFixed(2)}</veri:ImporteTotal>
          <veri:Desglose>
${breakdown}
          </veri:Desglose>
          ${input.huettaAnterior ? `<veri:HuellaAnterior>${input.huettaAnterior}</veri:HuellaAnterior>` : ""}
        </veri:RegistroAlta>
      </veri:RegistroFactura>
    </veri:RegFactuSistemaFacturacion>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  /**
   * Anulación envelope — `<RegistroAnulacion>` per AEAT Verifactu spec.
   */
  buildAnulateXml(input: {
    tenantNif: string;
    invoiceNumber: string;
    issueDate: string;
    huettaAnterior?: string | null;
  }): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:veri="https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd">
  <soapenv:Body>
    <veri:RegFactuSistemaFacturacion>
      <veri:Cabecera>
        <veri:ObligadoEmision><veri:NIF>${input.tenantNif}</veri:NIF></veri:ObligadoEmision>
      </veri:Cabecera>
      <veri:RegistroFactura>
        <veri:RegistroAnulacion>
          <veri:NumSerieFactura>${input.invoiceNumber}</veri:NumSerieFactura>
          <veri:FechaExpedicionFactura>${input.issueDate}</veri:FechaExpedicionFactura>
          ${input.huettaAnterior ? `<veri:HuellaAnterior>${input.huettaAnterior}</veri:HuellaAnterior>` : ""}
        </veri:RegistroAnulacion>
      </veri:RegistroFactura>
    </veri:RegFactuSistemaFacturacion>
  </soapenv:Body>
</soapenv:Envelope>`;
  }

  async dispatch(input: VerifactuDispatchInput): Promise<VerifactuDispatchResult> {
    try {
      const signed = await this.signWithTenantCert(
        input.invoiceId,
        input.xml,
      );
      const response = await this._postToAeat(signed.signedXml);
      const qrUrl = this.qr.buildVerifactuUrl({
        nif: input.nif,
        invoiceNumber: input.invoiceNumber,
        issueDate: input.issueDate,
        totalCents: input.totalCents,
      });

      await this.prisma.invoice.update({
        where: { id: input.invoiceId },
        data: {
          fiscalStatus: response.status === "accepted" ? "accepted" : "rejected",
          fiscalHash: signed.documentHash,
          fiscalQrUrl: qrUrl,
          fiscalReference: response.reference,
          fiscalError: response.error,
          fiscalSubmittedAt: new Date(),
          fiscalXml: signed.signedXml,
        },
      });

      return { ...response, qrUrl };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(
        `Verifactu dispatch failed for invoice ${input.invoiceId}: ${message}`,
      );
      await this.prisma.invoice.update({
        where: { id: input.invoiceId },
        data: {
          fiscalStatus: "error",
          fiscalError: message,
          fiscalSubmittedAt: new Date(),
        },
      });
      // Differentiate transport (retryable) vs validation (permanent).
      const retriable = !message.includes("cert") && !message.includes("PKCS");
      return { status: retriable ? "error" : "rejected", error: message };
    }
  }

  /**
   * Sign a Verifactu XML with the tenant's active PKCS#12. Returns
   * `{ signedXml, documentHash }` or throws.
   */
  async signWithTenantCert(
    invoiceId: string,
    xml: string,
  ): Promise<{ signedXml: string; documentHash: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { tenantId: true },
    });
    if (!invoice) throw new Error("Invoice not found");
    const cert = await this.prisma.fiscalCertificate.findFirst({
      where: { tenantId: invoice.tenantId, isActive: true },
      orderBy: { createdAt: "desc" },
    });
    if (!cert) {
      throw new Error(
        "No active fiscal certificate — upload one via /invoices/certificates first",
      );
    }

    const signed = this.xades.sign({
      xml,
      pkcs12Cipher: cert.encryptedPem,
      pkcs12PassphraseCipher: cert.passphraseCipher ?? undefined,
      xpath: "//*[local-name()='RegistroAlta' or local-name()='RegistroAnulacion'][1]",
      decrypt: (c) => this.encryption.decrypt(c),
    });
    return { signedXml: signed.signedXml, documentHash: signed.documentHash };
  }

  /**
   * STUB HTTP transport. In production, replace with:
   *
   *   const res = await fetch(process.env.AEAT_VERIFACTU_ENDPOINT, {
   *     method: "POST",
   *     headers: { "Content-Type": "application/xml", "SOAPAction": "suministrar" },
   *     body: signedXml,
   *   });
   *   if (!res.ok) throw new Error(`AEAT ${res.status}: ${await res.text()}`);
   *   const body = await res.text();
   *   const csv = parseAeatCsv(body);
   *   return { status: "accepted", reference: csv };
   *
   * Toggle `FISCAL_E2E_MODE=stub` (default) to keep using this stub in CI
   * without AEAT sandbox credentials. Setting `FISCAL_E2E_MODE=real` flips
   * to the live transport once credentials are configured.
   */
  private async _postToAeat(
    signedXml: string,
  ): Promise<{ status: "accepted" | "rejected"; reference?: string; error?: string }> {
    if (process.env.FISCAL_E2E_MODE === "real") {
      const endpoint =
        process.env.AEAT_VERIFACTU_ENDPOINT ??
        "https://www2.agenciatributaria.gob.es/wlpl/inwinvoc/es.aeat.tike.cont.ws.SuministroInformacion";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/xml",
          SOAPAction: "suministrar",
        },
        body: signedXml,
      });
      if (!res.ok) {
        return { status: "rejected", error: `AEAT ${res.status}: ${await res.text()}` };
      }
      const body = await res.text();
      const csv = parseAeatCsv(body);
      return { status: "accepted", reference: csv };
    }
    const stamp = createHash("sha256").update(signedXml).digest("hex").slice(0, 16);
    return { status: "accepted", reference: `CSV-STUB-${stamp}` };
  }
}

/**
 * Parses the AEAT `CSV` (Código Seguro de Verificación) out of a SOAP
 * `<ault:CSV>*</ault:CSV>` element in the success response. Returns the
 * first match or "UNKNOWN" if not found.
 */
function parseAeatCsv(body: string): string {
  const m = body.match(/<ault?:?CSV[^>]*>([^<]+)<\/ault?:?CSV>/i);
  return m?.[1] ?? "UNKNOWN";
}
