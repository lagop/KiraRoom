import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { Invoice, InvoiceLine, Prisma, VerifactuRecordKind, VerifactuRecordStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { PrismaService } from "../../../common/prisma/prisma.service";
import { producer } from "./config";
import * as format from "./format";
import { altaHash, anulacionHash } from "./hash";
import { qrUrl } from "./qr";
import { AltaRecord, InvoiceId, PreviousRecord, SystemInstallation, TaxLine, registroAlta, registroAnulacion } from "./xml";

type Tx = Prisma.TransactionClient;
type ChainContext = Awaited<ReturnType<VerifactuRecordsService["lockChain"]>>;

/**
 * Invoices of one salon are issued one after another (number, then record,
 * under the salon's lock): give a queued one time to wait its turn.
 */
export const ISSUE_TRANSACTION = { maxWait: 15_000, timeout: 30_000 } as const;

/** A factura simplificada may not exceed 3.000 € (RD 1619/2012 art. 4.2: peluquería e institutos de belleza). */
const SIMPLIFIED_LIMIT_CENTS = 300_000;

export interface RecordedInvoice {
  tipoFactura: string;
  hash: string;
  qrUrl: string;
}

/**
 * Generates the VERI*FACTU records: an alta when an invoice is issued, an
 * anulación when it is voided, a subsanación when the AEAT rejected one.
 *
 * Records are generated inside the transaction that issues the invoice,
 * whatever later happens with the submission: the regulation chains the
 * records in the order they are generated, not the order the AEAT accepts
 * them. (The previous code only advanced the chain on acceptance.) A
 * per-salon advisory lock keeps the chain strictly sequential.
 */
@Injectable()
export class VerifactuRecordsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The alta for an invoice just created in `tx`. */
  async recordInvoice(tx: Tx, invoiceId: string): Promise<RecordedInvoice> {
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
    const ctx = await this.lockChain(tx, invoice.tenantId);
    const alta = await this.buildAlta(tx, ctx, invoice, {});
    await this.append(tx, ctx, alta.row);
    const url = qrUrl({ nif: alta.row.nif, numSerie: alta.row.numSerie, fecha: alta.row.fecha, importeTotal: alta.row.importeTotal! });
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        fiscalHash: alta.row.hash,
        fiscalQrUrl: url,
        fiscalStatus: "pending",
        fiscalError: null,
        issuerTaxIdAtIssue: ctx.nif,
        issuerNameAtIssue: ctx.issuerName,
      },
    });
    return { tipoFactura: alta.row.tipoFactura!, hash: alta.row.hash, qrUrl: url };
  }

  /**
   * The anulación of an invoice that should never have existed. Returns
   * false when the invoice was issued before the salon switched VERI*FACTU
   * on, so there is nothing to annul at the AEAT.
   */
  async recordAnulacion(tx: Tx, invoiceId: string): Promise<boolean> {
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const ctx = await this.lockChain(tx, invoice.tenantId);
    const records = await tx.verifactuRecord.findMany({ where: { invoiceId }, orderBy: { sequence: "desc" } });
    if (records.length === 0) return false;
    if (records[0].kind === VerifactuRecordKind.anulacion) {
      throw new ConflictException("Esta factura ya está anulada");
    }
    const alta = records[0];
    const id = randomUUID();
    const generated = this.generationInstant(ctx.chain.lastGeneratedAt);
    const generatedAt = format.generatedAt(generated, ctx.timeZone);
    const hash = anulacionHash({
      idEmisorFacturaAnulada: alta.nif,
      numSerieFacturaAnulada: alta.numSerie,
      fechaExpedicionFacturaAnulada: alta.fecha,
      huellaAnterior: ctx.chain.lastHash,
      fechaHoraHusoGenRegistro: generatedAt,
    });
    const xml = registroAnulacion({
      refExterna: id,
      invoice: { nif: alta.nif, numSerie: alta.numSerie, fecha: alta.fecha },
      // The AEAT never registered the alta: it was rejected.
      sinRegistroPrevio: alta.status === VerifactuRecordStatus.rejected,
      previous: this.previous(ctx.chain),
      system: ctx.system,
      generatedAt,
      huella: hash,
    });
    await this.append(tx, ctx, {
      id,
      kind: VerifactuRecordKind.anulacion,
      invoiceId,
      nif: alta.nif,
      numSerie: alta.numSerie,
      fecha: alta.fecha,
      generatedAt,
      generatedInstant: generated,
      hash,
      xml,
    });
    return true;
  }

  /**
   * A new alta for an invoice whose record the AEAT rejected (Subsanacion=S,
   * RechazoPrevio=X) or accepted with errors (Subsanacion=S), chained as the
   * newest record. The record with errors is never modified; an issued
   * invoice does not change either, so the new record carries the same
   * invoice data.
   */
  async recordSubsanacion(tenantId: string, invoiceId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ctx = await this.lockChain(tx, tenantId);
      const last = await tx.verifactuRecord.findFirst({ where: { tenantId, invoiceId }, orderBy: { sequence: "desc" } });
      if (!last || last.kind !== VerifactuRecordKind.alta) {
        throw new BadRequestException("No hay un registro de alta que corregir");
      }
      if (last.status !== VerifactuRecordStatus.rejected && last.status !== VerifactuRecordStatus.accepted_with_errors) {
        throw new ConflictException("El registro no tiene errores que corregir");
      }
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
      const alta = await this.buildAlta(tx, ctx, invoice, {
        subsanacion: true,
        rechazoPrevio: last.status === VerifactuRecordStatus.rejected ? "X" : "N",
        // The invoice's identity stays the one first recorded.
        fecha: last.fecha,
      });
      await this.append(tx, ctx, alta.row);
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { fiscalHash: alta.row.hash, fiscalStatus: "pending", fiscalError: null },
      });
    }, ISSUE_TRANSACTION);
  }

  // ---- Building --------------------------------------------------------------

  private async buildAlta(
    tx: Tx,
    ctx: ChainContext,
    invoice: Invoice & { lines: InvoiceLine[] },
    opts: { subsanacion?: boolean; rechazoPrevio?: "N" | "X"; fecha?: string },
  ) {
    const numSerie = format.invoiceNumber(invoice.series, invoice.number);
    const fecha = opts.fecha ?? format.salonDate(invoice.issueDate, ctx.timeZone);
    const recipientNif = format.nif(invoice.recipientTaxId);
    if (invoice.recipientTaxId?.trim() && !recipientNif) {
      throw new BadRequestException(`El NIF del cliente "${invoice.recipientTaxId}" no es válido`);
    }

    let tipoFactura: AltaRecord["tipoFactura"];
    let rectified: InvoiceId[] | undefined;
    if (invoice.rectifiesInvoiceId) {
      const original = await tx.verifactuRecord.findFirst({
        where: { invoiceId: invoice.rectifiesInvoiceId, kind: VerifactuRecordKind.alta },
        orderBy: { sequence: "desc" },
      });
      if (!original) throw new BadRequestException("La factura que se rectifica no tiene registro Verifactu");
      // A simplified invoice is corrected with R5; any other with R1.
      tipoFactura = original.tipoFactura === "F2" || original.tipoFactura === "R5" ? "R5" : "R1";
      rectified = [{ nif: original.nif, numSerie: original.numSerie, fecha: original.fecha }];
    } else {
      tipoFactura = recipientNif ? "F1" : "F2";
      if (tipoFactura === "F2" && Math.abs(invoice.totalCents) > SIMPLIFIED_LIMIT_CENTS) {
        throw new BadRequestException("Una factura de más de 3.000 € tiene que ser completa: añade el nombre y el NIF del cliente.");
      }
    }
    const withRecipient = tipoFactura === "F1" || tipoFactura === "R1";
    if (withRecipient && !recipientNif) throw new BadRequestException("Esta factura necesita el NIF del cliente");

    const breakdown = (invoice.taxBreakdown as Array<{ rate: number; baseCents: number; taxCents: number }>) ?? [];
    if (breakdown.length < 1 || breakdown.length > 12) {
      throw new BadRequestException("Una factura Verifactu lleva entre 1 y 12 tipos de impuesto");
    }
    const desglose: TaxLine[] = breakdown.map((t) => ({
      impuesto: ctx.taxRegime === "igic" ? "03" : ctx.taxRegime === "ipsi" ? "02" : "01",
      rate: format.rate(t.rate),
      base: format.amount(t.baseCents),
      cuota: format.amount(t.taxCents),
    }));
    const cuotaTotal = format.amount(breakdown.reduce((s, t) => s + t.taxCents, 0));
    const importeTotal = format.amount(invoice.totalCents);
    const descripcion =
      format.text(invoice.lines.map((l) => l.description).filter(Boolean).join(", "), 500) || "Prestación de servicios";

    const id = randomUUID();
    const generated = this.generationInstant(ctx.chain.lastGeneratedAt);
    const generatedAt = format.generatedAt(generated, ctx.timeZone);
    const hash = altaHash({
      idEmisorFactura: ctx.nif,
      numSerieFactura: numSerie,
      fechaExpedicionFactura: fecha,
      tipoFactura,
      cuotaTotal,
      importeTotal,
      huellaAnterior: ctx.chain.lastHash,
      fechaHoraHusoGenRegistro: generatedAt,
    });
    const xml = registroAlta({
      refExterna: id,
      invoice: { nif: ctx.nif, numSerie, fecha },
      issuerName: ctx.issuerName,
      subsanacion: opts.subsanacion,
      rechazoPrevio: opts.rechazoPrevio,
      tipoFactura,
      tipoRectificativa: tipoFactura.startsWith("R") ? "I" : undefined,
      rectified,
      descripcion,
      recipient: withRecipient ? { name: format.text(invoice.recipientName, 120), nif: recipientNif! } : undefined,
      desglose,
      cuotaTotal,
      importeTotal,
      previous: this.previous(ctx.chain),
      system: ctx.system,
      generatedAt,
      huella: hash,
    });
    return {
      row: {
        id,
        kind: VerifactuRecordKind.alta,
        invoiceId: invoice.id,
        nif: ctx.nif,
        numSerie,
        fecha,
        tipoFactura,
        cuotaTotal,
        importeTotal,
        generatedAt,
        generatedInstant: generated,
        hash,
        xml,
        subsanacion: opts.subsanacion ?? false,
      },
    };
  }

  // ---- Chain -----------------------------------------------------------------

  private async lockChain(tx: Tx, tenantId: string) {
    // One generator at a time per salon: the chain must stay strictly sequential.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verifactu-chain:${tenantId}`}))`;
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { id: true, name: true, legalName: true, taxId: true, timezone: true, fiscalSettings: true },
    });
    const nif = format.nif(tenant.taxId);
    if (!nif) throw new BadRequestException("Configura el NIF del salón en los ajustes fiscales antes de facturar con Verifactu");
    const prod = producer();
    if (!prod) throw new BadRequestException("Verifactu no está configurado en KiraRoom (falta el productor del software)");
    const chain =
      (await tx.verifactuChain.findUnique({ where: { tenantId } })) ??
      (await tx.verifactuChain.create({ data: { tenantId, installationNumber: installationNumberFor(tenantId) } }));
    const settings = (tenant.fiscalSettings as Record<string, unknown>) ?? {};
    const system: SystemInstallation = {
      producer: prod,
      installationNumber: chain.installationNumber,
      userHasSeveralTaxpayers: false,
    };
    return {
      tenantId,
      nif,
      issuerName: format.text(tenant.legalName || tenant.name, 120),
      timeZone: tenant.timezone || "Europe/Madrid",
      taxRegime: settings.taxRegime === "igic" || settings.taxRegime === "ipsi" ? settings.taxRegime : "iva",
      chain,
      system,
    };
  }

  private previous(chain: { lastHash: string | null; lastNif: string | null; lastNumSerie: string | null; lastFecha: string | null }): PreviousRecord {
    if (!chain.lastHash) return null;
    return { nif: chain.lastNif!, numSerie: chain.lastNumSerie!, fecha: chain.lastFecha!, huella: chain.lastHash };
  }

  /** Now, but never before the previous record of the chain. */
  private generationInstant(last: Date | null): Date {
    const now = new Date();
    return last && last.getTime() > now.getTime() ? last : now;
  }

  private async append(
    tx: Tx,
    ctx: ChainContext,
    r: {
      id: string;
      kind: VerifactuRecordKind;
      invoiceId: string;
      nif: string;
      numSerie: string;
      fecha: string;
      tipoFactura?: string | null;
      cuotaTotal?: string | null;
      importeTotal?: string | null;
      generatedAt: string;
      generatedInstant: Date;
      hash: string;
      xml: string;
      subsanacion?: boolean;
    },
  ): Promise<void> {
    const sequence = ctx.chain.lastSequence + 1;
    await tx.verifactuRecord.create({
      data: {
        id: r.id,
        tenantId: ctx.tenantId,
        sequence,
        kind: r.kind,
        invoiceId: r.invoiceId,
        nif: r.nif,
        numSerie: r.numSerie,
        fecha: r.fecha,
        tipoFactura: r.tipoFactura ?? null,
        cuotaTotal: r.cuotaTotal ?? null,
        importeTotal: r.importeTotal ?? null,
        previousHash: ctx.chain.lastHash,
        generatedAt: r.generatedAt,
        hash: r.hash,
        xml: r.xml,
        subsanacion: r.subsanacion ?? false,
      },
    });
    await tx.verifactuChain.update({
      where: { tenantId: ctx.tenantId },
      data: {
        lastSequence: sequence,
        lastHash: r.hash,
        lastNif: r.nif,
        lastNumSerie: r.numSerie,
        lastFecha: r.fecha,
        lastGeneratedAt: r.generatedInstant,
      },
    });
  }
}

/** NumeroInstalacion: one per salon, never reused (FAQ desarrolladores §4). */
export function installationNumberFor(tenantId: string): string {
  return `KR-${tenantId}`;
}
