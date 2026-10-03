import { XMLParser } from "fast-xml-parser";

/**
 * Reading the AEAT answer to RegFactuSistemaFacturacion
 * (RespuestaSuministro.xsd), or the SOAP fault that rejects a whole
 * submission. Prefixes vary between the AEAT's own examples, so only local
 * names are used.
 */

export type EstadoRegistro = "Correcto" | "AceptadoConErrores" | "Incorrecto";

export interface ResponseLine {
  numSerie: string;
  fecha: string;
  operation: "Alta" | "Anulacion";
  refExterna?: string;
  estado: EstadoRegistro;
  errorCode?: number;
  errorDescription?: string;
  /** Set when the record was rejected as a duplicate (error 3000). */
  duplicateState?: "Correcta" | "AceptadaConErrores" | "Anulada";
}

export type AeatResponse =
  | {
      kind: "response";
      csv?: string;
      waitSeconds: number;
      estadoEnvio: "Correcto" | "ParcialmenteCorrecto" | "Incorrecto";
      lines: ResponseLine[];
    }
  | {
      kind: "fault";
      /** Server: resend as is. Client: the message itself is wrong. */
      side: "Server" | "Client";
      code?: number;
      message: string;
    };

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "RespuestaLinea",
});

const str = (v: unknown): string | undefined => (v == null || v === "" ? undefined : String(v));

export function parseResponse(xml: string): AeatResponse {
  const doc = parser.parse(xml);
  const body = doc?.Envelope?.Body;
  if (!body) throw new Error("La respuesta de la AEAT no es un mensaje SOAP");

  if (body.Fault) {
    const faultcode = String(body.Fault.faultcode ?? "");
    const message = String(body.Fault.faultstring ?? "Error SOAP sin descripción");
    const code = /Codigo\[(\d+)\]/.exec(message)?.[1];
    return {
      kind: "fault",
      side: /Server/i.test(faultcode) ? "Server" : "Client",
      code: code ? Number(code) : undefined,
      message,
    };
  }

  const r = body.RespuestaRegFactuSistemaFacturacion;
  if (!r) throw new Error("La respuesta de la AEAT no contiene RespuestaRegFactuSistemaFacturacion");
  const estadoEnvio = String(r.EstadoEnvio);
  if (!["Correcto", "ParcialmenteCorrecto", "Incorrecto"].includes(estadoEnvio)) {
    throw new Error(`EstadoEnvio desconocido: ${estadoEnvio}`);
  }
  const wait = Number(r.TiempoEsperaEnvio);
  const lines: ResponseLine[] = (r.RespuestaLinea ?? []).map((l: any) => {
    const code = str(l.CodigoErrorRegistro);
    return {
      numSerie: String(l.IDFactura?.NumSerieFactura ?? ""),
      fecha: String(l.IDFactura?.FechaExpedicionFactura ?? ""),
      operation: l.Operacion?.TipoOperacion === "Anulacion" ? "Anulacion" : "Alta",
      refExterna: str(l.RefExterna),
      estado: String(l.EstadoRegistro) as EstadoRegistro,
      errorCode: code ? Number(code) : undefined,
      errorDescription: str(l.DescripcionErrorRegistro),
      duplicateState: str(l.RegistroDuplicado?.EstadoRegistroDuplicado) as ResponseLine["duplicateState"],
    };
  });
  return {
    kind: "response",
    csv: str(r.CSV),
    waitSeconds: Number.isFinite(wait) && wait >= 0 ? wait : 60,
    estadoEnvio: estadoEnvio as "Correcto" | "ParcialmenteCorrecto" | "Incorrecto",
    lines,
  };
}
