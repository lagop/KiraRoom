import { Injectable, Logger, Optional } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { InvoiceFiscalStatus, VerifactuRecord, VerifactuRecordKind, VerifactuRecordStatus } from "@prisma/client";
import { EncryptionService } from "../../../common/encryption/encryption.service";
import { OpsAlertService } from "../../../common/ops-alerts/ops-alert.service";
import { PrismaService } from "../../../common/prisma/prisma.service";
import { openPkcs12 } from "./certificate";
import { fiscalSubmissionAvailable } from "../fiscal-availability";
import { INITIAL_WAIT_SECONDS, MAX_RECORDS_PER_SUBMISSION, endpoint } from "./config";
import * as format from "./format";
import { AeatResponse, ResponseLine, parseResponse } from "./response";
import { Credentials, VerifactuTransport } from "./transport";
import { envelope } from "./xml";

/** Retry after a failed submission: 1, 2, 4... minutes, at most an hour (the rule is "at least once an hour"). */
export function retryDelaySeconds(failedAttempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, failedAttempts - 1), 3600);
}

/** An anonymised salon with no certificate left: how often its queue is looked at. */
const ANONYMIZED_RETRY_SECONDS = 7 * 24 * 3600;

export type SendOutcome =
  | { kind: "nothing" }
  | { kind: "no-credentials" }
  | { kind: "not-prepared"; message: string }
  | { kind: "sent"; estadoEnvio: string; accepted: number; rejected: number }
  | { kind: "fault"; side: "Server" | "Client"; message: string }
  | { kind: "unreachable"; message: string };

/**
 * Sends each salon's pending records to the AEAT, in the order they were
 * generated, following the flow control of Orden HAC/1177/2024 art. 16:
 * after a submission, wait the TiempoEsperaEnvio the AEAT returned (60 s
 * at first) before the next one, up to 1.000 records per submission.
 *
 * If the AEAT cannot be reached the records stay queued and invoicing goes
 * on; the queue is retried (at least hourly) and the late records are sent
 * with Incidencia=S. Each submission and its answer are kept.
 */
@Injectable()
export class VerifactuDispatcher {
  private readonly logger = new Logger(VerifactuDispatcher.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly transport: VerifactuTransport,
    @Optional() private readonly opsAlerts?: OpsAlertService,
  ) {}

  @Interval(15_000)
  async tick(): Promise<void> {
    if (this.running || !fiscalSubmissionAvailable()) return;
    this.running = true;
    try {
      const due = await this.dueTenants();
      for (const tenantId of due) {
        await this.sendNext(tenantId).catch((err) =>
          this.logger.error(`VERI*FACTU submission for ${tenantId} failed: ${(err as Error).message}`),
        );
      }
    } finally {
      this.running = false;
    }
  }

  /** Salons with records waiting whose wait time has passed. */
  private async dueTenants(): Promise<string[]> {
    // From the chains, one row per salon: each EXISTS stops at the salon's
    // first pending record (index tenantId, status, sequence).
    const due = await this.prisma.$queryRaw<Array<{ tenantId: string }>>`
      SELECT c."tenantId" FROM verifactu_chains c
      WHERE c."nextSendAt" <= ${new Date()}
        AND EXISTS (
          SELECT 1 FROM verifactu_records r
          WHERE r."tenantId" = c."tenantId" AND r.status = 'pending'
        )`;
    return due.map((c) => c.tenantId);
  }

  /** One submission for one salon: up to 1.000 of its oldest pending records. */
  async sendNext(tenantId: string): Promise<SendOutcome> {
    const now = new Date();
    // Claim the slot, so two processes never send the same queue at once.
    const claimed = await this.prisma.verifactuChain.updateMany({
      where: { tenantId, nextSendAt: { lte: now } },
      data: { nextSendAt: new Date(now.getTime() + 5 * 60_000) },
    });
    if (claimed.count !== 1) return { kind: "nothing" };
    const chain = await this.prisma.verifactuChain.findUniqueOrThrow({ where: { tenantId } });

    const first = await this.prisma.verifactuRecord.findFirst({
      where: { tenantId, status: VerifactuRecordStatus.pending },
      orderBy: { sequence: "asc" },
    });
    if (!first) {
      await this.prisma.verifactuChain.update({ where: { tenantId }, data: { nextSendAt: now } });
      return { kind: "nothing" };
    }
    // One taxpayer per message: if the salon's NIF changed, older records go first, on their own.
    const records = await this.prisma.verifactuRecord.findMany({
      where: { tenantId, status: VerifactuRecordStatus.pending, nif: first.nif },
      orderBy: { sequence: "asc" },
      take: MAX_RECORDS_PER_SUBMISSION,
    });

    // An anonymised salon's records stay queued like any other: the certificate
    // is kept for them (TENANT_MODEL_ON_ERASURE) and they are still its invoices.
    const tenant = await this.prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, legalName: true, anonymizedAt: true },
    });
    const incidencia = chain.incidentSince != null;
    // The slot is claimed: from here a failure has to reach the chain, or the
    // queue would wait with nothing telling the salon why (art. 16.4).
    let credentials: Credentials | null;
    let body = "";
    try {
      credentials = await this.credentials(tenantId);
      if (credentials) {
        body = envelope(
          { name: await this.obligadoName(first, tenant), nif: first.nif },
          records.map((r) => r.xml),
          incidencia,
        );
      }
    } catch (err) {
      const detail = (err as Error).message;
      this.logger.error(`VERI*FACTU ${tenantId}: the submission could not be prepared: ${detail}`);
      const message = "No se ha podido preparar el envío a la AEAT. Revisa el certificado electrónico.";
      await this.failed(tenantId, chain.failedAttempts, message, false);
      await this.alert(tenantId, "envío sin preparar", detail);
      return { kind: "not-prepared", message };
    }
    if (!credentials) {
      const message = "Falta el certificado electrónico para enviar a la AEAT";
      if (tenant.anonymizedAt) {
        // Nobody is left to upload one: the platform owner hears, and it is
        // tried again weekly, not hourly forever. The records stay pending.
        await this.failed(tenantId, chain.failedAttempts, message, false, ANONYMIZED_RETRY_SECONDS);
        await this.alert(tenantId, "salón anonimizado con registros sin enviar", message);
      } else {
        await this.failed(tenantId, chain.failedAttempts, message, false);
      }
      return { kind: "no-credentials" };
    }

    const url = endpoint(credentials.type);
    await this.prisma.verifactuRecord.updateMany({
      where: { id: { in: records.map((r) => r.id) } },
      data: { attempts: { increment: 1 } },
    });

    let reply: { status: number; body: string };
    try {
      reply = await this.transport.post(url, body, credentials, { ca: process.env.VERIFACTU_EXTRA_CA_PEM || undefined });
    } catch (err) {
      const message = (err as Error).message;
      await this.log(tenantId, url, records.length, incidencia, { error: message });
      await this.failed(tenantId, chain.failedAttempts, `No se ha podido conectar con la AEAT: ${message}`, true);
      return { kind: "unreachable", message };
    }

    let parsed: AeatResponse;
    try {
      parsed = parseResponse(reply.body);
    } catch (err) {
      const message = `Respuesta inesperada de la AEAT (HTTP ${reply.status}): ${(err as Error).message}`;
      await this.log(tenantId, url, records.length, incidencia, { httpStatus: reply.status, error: message, response: reply.body });
      // No usable answer: resend (web-service description §5.1).
      await this.failed(tenantId, chain.failedAttempts, message, true);
      return { kind: "unreachable", message };
    }

    if (parsed.kind === "fault") {
      await this.log(tenantId, url, records.length, incidencia, {
        httpStatus: reply.status,
        faultCode: parsed.code,
        error: parsed.message,
        response: reply.body,
      });
      // Server: resend as is, it is the AEAT's problem. Client: the message
      // or the certificate is wrong; retry hourly in case it gets fixed, and
      // tell the platform owner, as nothing here will fix it on its own. It
      // does not open an incident: an incident already open stays open.
      await this.failed(tenantId, chain.failedAttempts, `La AEAT rechazó el envío: ${parsed.message}`, parsed.side === "Server");
      if (parsed.side === "Client") {
        await this.alert(tenantId, "envío rechazado por la AEAT (SOAP Client)", `Código ${parsed.code ?? "?"}: ${parsed.message}`);
      }
      return { kind: "fault", side: parsed.side, message: parsed.message };
    }

    const submission = await this.log(tenantId, url, records.length, incidencia, {
      httpStatus: reply.status,
      estadoEnvio: parsed.estadoEnvio,
      csv: parsed.csv,
      waitSeconds: parsed.waitSeconds,
      response: reply.body,
    });
    const tally = await this.applyResults(records, parsed, submission.id);
    if (tally.rejected > 0) {
      await this.alert(tenantId, "registros rechazados por la AEAT", `${tally.rejected} de ${records.length} en el envío ${submission.id}`);
    }
    await this.prisma.verifactuChain.update({
      where: { tenantId },
      data: {
        nextSendAt: new Date(Date.now() + (parsed.waitSeconds || INITIAL_WAIT_SECONDS) * 1000),
        waitSeconds: parsed.waitSeconds || INITIAL_WAIT_SECONDS,
        incidentSince: null,
        failedAttempts: 0,
        lastError: null,
      },
    });
    return { kind: "sent", estadoEnvio: parsed.estadoEnvio, ...tally };
  }

  private async applyResults(records: VerifactuRecord[], response: Extract<AeatResponse, { kind: "response" }>, submissionId: string) {
    const byRef = new Map(response.lines.filter((l) => l.refExterna).map((l) => [l.refExterna!, l]));
    const byKey = new Map(response.lines.map((l) => [`${l.operation}|${l.numSerie}|${l.fecha}`, l]));
    let accepted = 0;
    let rejected = 0;
    const sentAt = new Date();
    for (const record of records) {
      const operation = record.kind === VerifactuRecordKind.anulacion ? "Anulacion" : "Alta";
      const line = byRef.get(record.id) ?? byKey.get(`${operation}|${record.numSerie}|${record.fecha}`);
      const status = recordStatus(line, response.estadoEnvio);
      if (status === null) continue; // Not answered: it stays queued.
      if (status === VerifactuRecordStatus.rejected) rejected++;
      else accepted++;
      await this.prisma.verifactuRecord.update({
        where: { id: record.id },
        data: {
          status,
          submissionId,
          sentAt,
          csv: response.csv ?? null,
          errorCode: line?.errorCode ?? null,
          errorDescription: line?.errorDescription ?? null,
        },
      });
      if (record.invoiceId) await this.reflectOnInvoice(record, status, response.csv, line);
    }
    return { accepted, rejected };
  }

  /** The invoice shows the state of its newest record. */
  private async reflectOnInvoice(record: VerifactuRecord, status: VerifactuRecordStatus, csv: string | undefined, line?: ResponseLine) {
    const newest = await this.prisma.verifactuRecord.findFirst({
      where: { invoiceId: record.invoiceId },
      orderBy: { sequence: "desc" },
      select: { id: true },
    });
    if (newest?.id !== record.id) return;
    const error = line?.errorCode ? `${line.errorCode}: ${line.errorDescription ?? ""}`.trim() : null;
    const isAnulacion = record.kind === VerifactuRecordKind.anulacion;
    await this.prisma.invoice.update({
      where: { id: record.invoiceId! },
      data: {
        fiscalStatus:
          status === VerifactuRecordStatus.rejected ? InvoiceFiscalStatus.rejected : InvoiceFiscalStatus.accepted,
        ...(csv && !isAnulacion ? { fiscalReference: csv } : {}),
        fiscalError:
          status === VerifactuRecordStatus.rejected
            ? `${isAnulacion ? "Anulación rechazada" : "Rechazada"} por la AEAT. ${error ?? ""}`.trim()
            : status === VerifactuRecordStatus.accepted_with_errors
              ? `Aceptada con errores. ${error ?? ""}`.trim()
              : null,
        fiscalSubmittedAt: new Date(),
      },
    });
  }

  /**
   * The taxpayer's name: the one recorded on its invoice when it was issued.
   * Anonymising renames the salon, and the AEAT must still get the razón social.
   */
  private async obligadoName(
    record: VerifactuRecord,
    tenant: { name: string; legalName: string | null },
  ): Promise<string> {
    const invoice = record.invoiceId
      ? await this.prisma.invoice.findUnique({ where: { id: record.invoiceId }, select: { issuerNameAtIssue: true } })
      : null;
    return format.text(invoice?.issuerNameAtIssue || tenant.legalName || tenant.name, 120);
  }

  /** The platform owner by email, at most one an hour (audit 8 D15). Never throws. */
  private async alert(tenantId: string, what: string, detail: string): Promise<void> {
    await this.opsAlerts
      ?.notify("fiscal_rejected", `VERI*FACTU: ${what}`, `Salón (tenantId): ${tenantId}\n${detail}`)
      .catch(() => undefined);
  }

  private async failed(tenantId: string, previousFailures: number, message: string, incident: boolean, retrySeconds?: number) {
    const attempts = previousFailures + 1;
    const delay = retrySeconds ?? (incident ? retryDelaySeconds(attempts) : 3600);
    const chain = await this.prisma.verifactuChain.findUniqueOrThrow({ where: { tenantId }, select: { incidentSince: true } });
    await this.prisma.verifactuChain.update({
      where: { tenantId },
      data: {
        nextSendAt: new Date(Date.now() + delay * 1000),
        failedAttempts: attempts,
        lastError: message,
        incidentSince: incident ? (chain.incidentSince ?? new Date()) : chain.incidentSince,
      },
    });
    this.logger.warn(`VERI*FACTU ${tenantId}: ${message} (retry in ${delay} s)`);
  }

  private log(
    tenantId: string,
    url: string,
    recordCount: number,
    incidencia: boolean,
    result: {
      httpStatus?: number;
      estadoEnvio?: string;
      csv?: string;
      waitSeconds?: number;
      faultCode?: number;
      error?: string;
      response?: string;
    },
  ) {
    return this.prisma.verifactuSubmission.create({
      data: {
        tenantId,
        endpoint: url,
        recordCount,
        incidencia,
        httpStatus: result.httpStatus ?? null,
        estadoEnvio: result.estadoEnvio ?? null,
        csv: result.csv ?? null,
        waitSeconds: result.waitSeconds ?? null,
        faultCode: result.faultCode ?? null,
        error: result.error?.slice(0, 4000) ?? null,
        response: result.response?.slice(0, 200_000) ?? null,
      },
    });
  }

  /** The certificate to submit with: always the salon's own. */
  async credentials(tenantId: string): Promise<Credentials | null> {
    const cert = await this.prisma.fiscalCertificate.findFirst({
      where: { tenantId, isActive: true, notAfter: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (cert) {
      const type = cert.certificateType === "seal" ? "seal" : "personal";
      if (cert.encryptedKeyPair) {
        const pair = JSON.parse(this.encryption.decrypt(cert.encryptedKeyPair)) as { keyPem: string; certPem: string };
        return { key: pair.keyPem, cert: pair.certPem, type };
      }
      // Uploaded before the key pair was stored: open the PKCS#12 now.
      const der = this.encryption.decrypt(cert.encryptedPem);
      const password = cert.passphraseCipher ? this.encryption.decrypt(cert.passphraseCipher) : "";
      const opened = openPkcs12(Buffer.from(der, "binary").toString("base64"), password);
      return { key: opened.keyPem, cert: opened.certPem, type };
    }
    return null;
  }
}

/**
 * What the AEAT's answer means for one record; null when it did not
 * mention it (it stays queued and goes again).
 */
export function recordStatus(line: ResponseLine | undefined, estadoEnvio: string): VerifactuRecordStatus | null {
  if (!line) return estadoEnvio === "Correcto" ? VerifactuRecordStatus.accepted : null;
  if (line.estado === "Correcto") return VerifactuRecordStatus.accepted;
  if (line.estado === "AceptadoConErrores") return VerifactuRecordStatus.accepted_with_errors;
  // Sent before and registered, but the answer was lost: error 3000 with the stored state.
  if (line.errorCode === 3000 && line.duplicateState) {
    return line.duplicateState === "AceptadaConErrores" ? VerifactuRecordStatus.accepted_with_errors : VerifactuRecordStatus.accepted;
  }
  return VerifactuRecordStatus.rejected;
}
