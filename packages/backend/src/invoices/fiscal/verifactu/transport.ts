import { Injectable } from "@nestjs/common";
import { request } from "https";
import * as tls from "tls";

/** A client certificate for mutual TLS with the AEAT. */
export interface Credentials {
  key: string;
  /** The certificate, followed by any intermediates the bundle carried (PEM). */
  cert: string;
  /** Seal certificates go to www10 / prewww10. */
  type: "personal" | "seal";
}

export interface TransportReply {
  status: number;
  body: string;
}

/**
 * HTTPS with a client certificate: the AEAT web services identify who
 * submits from the TLS connection itself ("deberán autenticarse con
 * certificado electrónico cualificado", web-service description §4.3). The
 * old transport posted with plain fetch, without any certificate.
 *
 * SOAP 1.1, document/literal, UTF-8, empty SOAPAction (SistemaFacturacion.wsdl).
 * A SOAP fault comes back with HTTP 500 and a body; it is returned, not
 * thrown, so the caller can read it.
 */
@Injectable()
export class VerifactuTransport {
  post(
    url: string,
    body: string,
    credentials: Credentials,
    options: {
      timeoutMs?: number;
      /** Extra certificate authorities to trust for the AEAT server (PEM), on top of Node's own. */
      ca?: string;
    } = {},
  ): Promise<TransportReply> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(body, "utf8");
      const req = request(
        url,
        {
          method: "POST",
          key: credentials.key,
          cert: credentials.cert,
          minVersion: "TLSv1.2",
          ...(options.ca ? { ca: [...tls.rootCertificates, options.ca] } : {}),
          headers: {
            "Content-Type": "text/xml; charset=UTF-8",
            SOAPAction: '""',
            "Content-Length": payload.length,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`Sin respuesta de la AEAT en ${timeoutMs / 1000} s`)));
      req.on("error", reject);
      req.end(payload);
    });
  }
}
