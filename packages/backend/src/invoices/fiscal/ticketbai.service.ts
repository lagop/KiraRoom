import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { createHash } from "crypto";
import { XadesService } from "./xades.service";
import { QrService } from "./qr.service";

export type Diputacion = "bizkaia" | "gipuzkoa" | "alava";

export interface TicketBaiDispatchInput {
  invoiceId: string;
  xml: string;
  invoiceNumber: string;
  issueDate: string;
  totalCents: number;
  tenantNif: string;
  recipientNif?: string;
  diputacion: Diputacion;
}

export interface TicketBaiDispatchResult {
  status: "accepted" | "rejected" | "error";
  tbaiCode?: string;
  qrUrl?: string;
  error?: string;
}

/**
 * TicketBAI dispatch for the three Basque deputaciones.
 *
 * Production-real (post-F2):
 *   1. Builds the TBAI 1.2 XML envelope.
 *   2. Signs with the tenant's active PKCS#12 via XadesService.
 *   3. POSTs to the per-diputación endpoint.
 *   4. Persists the response.
 *
 * Under `FISCAL_E2E_MODE=stub` (default) the HTTP transport returns a
 * deterministic accepted response.
 */
@Injectable()
export class TicketBaiService {
  private readonly logger = new Logger(TicketBaiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly xades: XadesService,
    private readonly qr: QrService,
  ) {}

  buildTbaiXml(input: {
    invoiceNumber: string;
    issueDate: string;
    totalCents: number;
    tenantNif: string;
    recipientNif?: string;
    breakdown: Array<{ rate: number; baseCents: number; taxCents: number }>;
    huettaAnterior?: string | null;
  }): string {
    const breakdown = input.breakdown
      .map(
        (t) =>
          `    <DetalleIVA>
      <TipoImpositivo>${t.rate}</TipoImpositivo>
      <BaseImponible>${(t.baseCents / 100).toFixed(2)}</BaseImponible>
      <CuotaIVA>${(t.taxCents / 100).toFixed(2)}</CuotaIVA>
    </DetalleIVA>`,
      )
      .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<T:TicketBai xmlns:T="https://www.batuz.eus/ekonomiazaintza/ticketbai/schemas">
  <T:Cabecera>
    <T:IDVersionTBAI>1.2</T:IDVersionTBAI>
  </T:Cabecera>
  <T:Sujetos>
    <T:Emisor><T:NIF>${input.tenantNif}</T:NIF></T:Emisor>
    ${input.recipientNif ? `<T:Destinatario><T:NIF>${input.recipientNif}</T:NIF></T:Destinatario>` : ""}
  </T:Sujetos>
  <T:Factura>
    <T:NumSerieFactura>${input.invoiceNumber}</T:NumSerieFactura>
    <T:FechaExpedicionFactura>${input.issueDate}</T:FechaExpedicionFactura>
    <T:ImporteTotalFactura>${(input.totalCents / 100).toFixed(2)}</T:ImporteTotalFactura>
    <T:Desglose>
${breakdown}
    </T:Desglose>
    ${input.huettaAnterior ? `<T:HuellaAnterior>${input.huettaAnterior}</T:HuellaAnterior>` : ""}
  </T:Factura>
</T:TicketBai>`;
  }

  buildAnulateXml(input: {
    invoiceNumber: string;
    issueDate: string;
    tenantNif: string;
    huettaAnterior?: string | null;
  }): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<T:AnulacionTicketBai xmlns:T="https://www.batuz.eus/ekonomiazaintza/ticketbai/schemas">
  <T:Cabecera><T:IDVersionTBAI>1.2</T:IDVersionTBAI></T:Cabecera>
  <T:Sujetos><T:Emisor><T:NIF>${input.tenantNif}</T:NIF></T:Emisor></T:Sujetos>
  <T:Factura>
    <T:NumSerieFactura>${input.invoiceNumber}</T:NumSerieFactura>
    <T:FechaExpedicionFactura>${input.issueDate}</T:FechaExpedicionFactura>
    ${input.huettaAnterior ? `<T:HuellaAnterior>${input.huettaAnterior}</T:HuellaAnterior>` : ""}
  </T:Factura>
</T:AnulacionTicketBai>`;
  }

  async dispatch(input: TicketBaiDispatchInput): Promise<TicketBaiDispatchResult> {
    try {
      const signed = await this.signWithTenantCert(input.invoiceId, input.xml);
      const response = await this._postToDeputacion(
        input.diputacion,
        signed.signedXml,
      );
      const qrUrl = this.qr.buildTicketBaiUrl(
        input.diputacion,
        response.tbaiCode ?? "",
      );

      await this.prisma.invoice.update({
        where: { id: input.invoiceId },
        data: {
          fiscalStatus: response.status === "accepted" ? "accepted" : "rejected",
          fiscalHash: signed.documentHash,
          fiscalQrUrl: qrUrl,
          fiscalReference: response.tbaiCode,
          fiscalError: response.error,
          fiscalSubmittedAt: new Date(),
          fiscalXml: signed.signedXml,
        },
      });

      return { ...response, qrUrl };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(
        `TicketBAI dispatch failed for invoice ${input.invoiceId}: ${message}`,
      );
      await this.prisma.invoice.update({
        where: { id: input.invoiceId },
        data: {
          fiscalStatus: "error",
          fiscalError: message,
          fiscalSubmittedAt: new Date(),
        },
      });
      return { status: "error", error: message };
    }
  }

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
      xpath: "//*[local-name()='Factura' or local-name()='AnulacionTicketBai'][1]",
      decrypt: (c) => this.encryption.decrypt(c),
    });
    return { signedXml: signed.signedXml, documentHash: signed.documentHash };
  }

  private async _postToDeputacion(
    diputacion: Diputacion,
    signedXml: string,
  ): Promise<{ status: "accepted" | "rejected"; tbaiCode?: string; error?: string }> {
    if (process.env.FISCAL_E2E_MODE === "real") {
      const envKey = `DIPUTACION_TBAI_${diputacion.toUpperCase()}`;
      const endpoint =
        process.env[envKey] ??
        this.defaultEndpoint(diputacion);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: signedXml,
      });
      if (!res.ok) {
        return {
          status: "rejected",
          error: `${diputacion} ${res.status}: ${await res.text()}`,
        };
      }
      const body = await res.text();
      const code = this.parseTbaiCode(body);
      return { status: "accepted", tbaiCode: code };
    }
    const stamp = createHash("sha256")
      .update(signedXml + diputacion)
      .digest("hex")
      .slice(0, 16);
    return { status: "accepted", tbaiCode: `TBAI-STUB-${stamp}` };
  }

  private defaultEndpoint(diputacion: Diputacion): string {
    switch (diputacion) {
      case "bizkaia":
        return "https://www.batuz.eus/qqtbai/api/v1/recepcion";
      case "gipuzkoa":
        return "https://tbai.gipuzkoa.eus/qrattbai/api/v1/recepcion";
      case "alava":
        return "https://tbai.araba.eus/qrattbai/api/v1/recepcion";
    }
  }

  /** Extracts the TBAI code from `<T:TBAI>...</T:TBAI>` or `<TBAI>...</TBAI>`. */
  private parseTbaiCode(body: string): string {
    const m = body.match(/<T?:?TBAI[^>]*>([A-Z0-9]{20,})<\/T?:?TBAI>/i);
    return m?.[1] ?? "UNKNOWN";
  }
}
