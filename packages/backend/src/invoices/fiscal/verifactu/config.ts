import * as format from "./format";

/**
 * The billing system itself, as every record identifies it
 * (SistemaInformatico) and as the producer's declaración responsable
 * describes it (Orden HAC/1177/2024 art. 15). The name, code and version
 * here must match that declaration: each version is a distinct product
 * with its own declaration, so bump VERSION with any change to how records
 * are generated or sent.
 */
export const SYSTEM = {
  name: "KiraRoom",
  /** IdSistemaInformatico: exactly two upper-case letters (not Ñ) or digits. */
  id: "KR",
  version: "1.0.0",
  /** It only works as VERI*FACTU: records are always sent to the AEAT. */
  onlyVerifactu: true,
  /** One installation serves many salons, each its own taxpayer. */
  multipleTaxpayers: true,
} as const;

/** The producer of the software (the company behind KiraRoom), from the environment. */
export interface Producer {
  name: string;
  nif: string;
}

export function producer(env: NodeJS.ProcessEnv = process.env): Producer | null {
  const name = env.VERIFACTU_PRODUCER_NAME?.trim();
  const nif = format.nif(env.VERIFACTU_PRODUCER_NIF);
  return name && nif ? { name: format.text(name, 120), nif } : null;
}

export type AeatEnvironment = "test" | "production";

/**
 * Which AEAT environment receives the records. Production must be chosen
 * explicitly: a misconfigured server sends to the test environment, where
 * nothing has legal effect, rather than the other way round.
 */
export function environment(env: NodeJS.ProcessEnv = process.env): AeatEnvironment {
  return env.VERIFACTU_ENV === "production" ? "production" : "test";
}

/**
 * VERI*FACTU SOAP endpoints (SistemaFacturacion.wsdl, service sfVerifactu).
 * www1/prewww1 take personal or entity certificates; www10/prewww10 take
 * seal certificates ("certificado de sello").
 */
const ENDPOINTS: Record<AeatEnvironment, { personal: string; seal: string }> = {
  production: {
    personal: "https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP",
    seal: "https://www10.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP",
  },
  test: {
    personal: "https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP",
    seal: "https://prewww10.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP",
  },
};

export function endpoint(kind: "personal" | "seal", env: NodeJS.ProcessEnv = process.env): string {
  return ENDPOINTS[environment(env)][kind];
}

/**
 * What the declaración responsable shows besides the producer's name and NIF
 * (Orden HAC/1177/2024 art. 15.1 j and l): its postal address, and the date
 * and place where it signs the declaration for this version.
 */
export function declarationDetails(env: NodeJS.ProcessEnv = process.env) {
  return {
    address: env.VERIFACTU_PRODUCER_ADDRESS?.trim() || null,
    contactEmail: env.VERIFACTU_PRODUCER_EMAIL?.trim() || null,
    signedOn: env.VERIFACTU_DECLARATION_DATE?.trim() || null,
    signedAt: env.VERIFACTU_DECLARATION_PLACE?.trim() || null,
  };
}

/** The public QR check (DetalleEspecificacTecnCodigoQRfactura v0.5.0 §5.1). */
const QR_BASE: Record<AeatEnvironment, string> = {
  production: "https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR",
  test: "https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR",
};

export function qrBase(env: NodeJS.ProcessEnv = process.env): string {
  return QR_BASE[environment(env)];
}

/**
 * Whether salons may switch VERI*FACTU on. It needs the producer's
 * identity (every record carries it) and, in production, the explicit
 * FISCAL_SUBMISSION_ENABLED=1 that also guarded the old stub transports.
 */
export function verifactuAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!producer(env)) return false;
  return env.NODE_ENV !== "production" || env.FISCAL_SUBMISSION_ENABLED === "1";
}

/** Maximum records per submission (SuministroLR.xsd, RegistroFactura maxOccurs). */
export const MAX_RECORDS_PER_SUBMISSION = 1000;
/** Initial wait between submissions (Orden HAC/1177/2024 art. 16.2). */
export const INITIAL_WAIT_SECONDS = 60;
