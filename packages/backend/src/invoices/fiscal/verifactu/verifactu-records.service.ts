import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { Invoice, InvoiceLine, Prisma, VerifactuRecord, VerifactuRecordKind, VerifactuRecordStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { PrismaService } from "../../../common/prisma/prisma.service";
import { DEFAULT_SALON_TIMEZONE, taxRegimeOf } from "@kira/shared";
import { dayOfIssueDate, SIMPLIFIED_SERIES } from "../../invoice-numbering";
import { producer } from "./config";
import * as format from "./format";
import { altaHash, anulacionHash } from "./hash";
import { qrUrl } from "./qr";
import { AltaRecord, InvoiceId, PreviousRecord, SystemInstallation, TaxLine, registroAlta, registroAnulacion } from "./xml";
import { ZERO_RATE_FALLBACK, zeroRateIsChosen, zeroRateTreatmentOf } from "./zero-rate";

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

  /**
   * Waits for the salon's turn in `tx`, until it commits: one generator at a
   * time per salon, so the chain stays strictly sequential. Re-entrant.
   * Advisory: nothing else in the salon waits for it, only its invoices.
   */
  async lockSalon(tx: Tx, tenantId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verifactu-chain:${tenantId}`}))`;
  }

  /**
   * Whether the salon went through activation: its chain row is created
   * there (InvoicesController.checkFiscalModeChange), with the certificate
   * and NIF checked. A salon whose fiscalMode says verifactu without it
   * (set by hand, or under the old stubs) invoices as if it were off,
   * instead of failing every invoice.
   */
  async isActivated(tx: Tx, tenantId: string): Promise<boolean> {
    return (await tx.verifactuChain.count({ where: { tenantId } })) > 0;
  }

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
   * false when the invoice has no record (issued before the salon switched
   * VERI*FACTU on, or the salon never did): nothing to annul at the AEAT,
   * and nothing here is read or locked for it beyond this count.
   */
  async recordAnulacion(tx: Tx, invoiceId: string): Promise<boolean> {
    if ((await tx.verifactuRecord.count({ where: { invoiceId } })) === 0) return false;
    const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const ctx = await this.lockChain(tx, invoice.tenantId);
    const records = await tx.verifactuRecord.findMany({ where: { invoiceId }, orderBy: { sequence: "desc" } });
    if (records[0].kind === VerifactuRecordKind.anulacion) {
      throw new ConflictException("Esta factura ya está anulada");
    }
    await this.appendAnulacion(tx, ctx, invoiceId, records, false);
    return true;
  }

  /**
   * A new anulación for an invoice whose anulación the AEAT rejected, chained
   * as the newest record, with RechazoPrevio=S. SinRegistroPrevio is worked
   * out again: the alta may have been rejected after the first anulación was
   * generated (the salon cancelled while it was still queued).
   */
  async recordAnulacionAgain(tenantId: string, invoiceId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ctx = await this.lockChain(tx, tenantId);
      const records = await tx.verifactuRecord.findMany({ where: { tenantId, invoiceId }, orderBy: { sequence: "desc" } });
      if (records[0]?.kind !== VerifactuRecordKind.anulacion) {
        throw new BadRequestException("No hay un registro de anulación que repetir");
      }
      if (records[0].status !== VerifactuRecordStatus.rejected) {
        throw new ConflictException("El registro no tiene errores que corregir");
      }
      await this.appendAnulacion(tx, ctx, invoiceId, records, true);
      await tx.invoice.update({ where: { id: invoiceId }, data: { fiscalStatus: "pending", fiscalError: null } });
    }, ISSUE_TRANSACTION);
  }

  private async appendAnulacion(tx: Tx, ctx: ChainContext, invoiceId: string, records: VerifactuRecord[], rechazoPrevio: boolean) {
    // Its newest record: the alta, or the rejected anulación being repeated.
    // Both identify the same invoice.
    const newest = records[0];
    const id = randomUUID();
    const generated = this.generationInstant(ctx.chain.lastGeneratedAt);
    const generatedAt = format.generatedAt(generated, ctx.timeZone);
    const hash = anulacionHash({
      idEmisorFacturaAnulada: newest.nif,
      numSerieFacturaAnulada: newest.numSerie,
      fechaExpedicionFacturaAnulada: newest.fecha,
      huellaAnterior: ctx.chain.lastHash,
      fechaHoraHusoGenRegistro: generatedAt,
    });
    const xml = registroAnulacion({
      refExterna: id,
      invoice: { nif: newest.nif, numSerie: newest.numSerie, fecha: newest.fecha },
      sinRegistroPrevio: !holdsAlta(records),
      rechazoPrevio,
      previous: this.previous(ctx.chain),
      system: ctx.system,
      generatedAt,
      huella: hash,
    });
    await this.append(tx, ctx, {
      id,
      kind: VerifactuRecordKind.anulacion,
      invoiceId,
      nif: newest.nif,
      numSerie: newest.numSerie,
      fecha: newest.fecha,
      generatedAt,
      generatedInstant: generated,
      hash,
      xml,
    });
  }

  /**
   * A new alta for an invoice whose record the AEAT rejected or accepted
   * with errors (Subsanacion=S; RechazoPrevio=X when the AEAT holds no alta of
   * it, S when it holds an earlier one), chained as the newest record. The record with errors is never modified; an issued
   * invoice does not change either, so the new record carries the same
   * invoice data.
   */
  async recordSubsanacion(tenantId: string, invoiceId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const ctx = await this.lockChain(tx, tenantId);
      const records = await tx.verifactuRecord.findMany({ where: { tenantId, invoiceId }, orderBy: { sequence: "desc" } });
      const last = records[0];
      if (!last || last.kind !== VerifactuRecordKind.alta) {
        throw new BadRequestException("No hay un registro de alta que corregir");
      }
      if (last.status !== VerifactuRecordStatus.rejected && last.status !== VerifactuRecordStatus.accepted_with_errors) {
        throw new ConflictException("El registro no tiene errores que corregir");
      }
      const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { lines: true } });
      const alta = await this.buildAlta(tx, ctx, invoice, {
        subsanacion: true,
        rechazoPrevio: last.status !== VerifactuRecordStatus.rejected ? "N" : holdsAlta(records) ? "S" : "X",
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
    opts: { subsanacion?: boolean; rechazoPrevio?: AltaRecord["rechazoPrevio"]; fecha?: string },
  ) {
    const numSerie = format.invoiceNumber(invoice.series, invoice.number);
    // The issue date is the salon's day stored at 00:00 UTC (invoice-numbering.ts).
    const fecha = opts.fecha ?? recordDate(invoice.issueDate, ctx.timeZone);
    const recipient = format.recipientId(invoice.recipientTaxId);
    const ticket = invoice.series === SIMPLIFIED_SERIES;

    let tipoFactura: AltaRecord["tipoFactura"];
    let rectified: InvoiceId[] | undefined;
    if (invoice.rectifiesInvoiceId) {
      const original = await tx.verifactuRecord.findFirst({
        where: { invoiceId: invoice.rectifiesInvoiceId, kind: VerifactuRecordKind.alta },
        orderBy: { sequence: "desc" },
      });
      if (original) {
        // A simplified invoice is corrected with R5; any other with R1. It
        // follows the original, which the AEAT holds under that type.
        tipoFactura = original.tipoFactura === "F2" || original.tipoFactura === "R5" ? "R5" : "R1";
        rectified = [{ nif: original.nif, numSerie: original.numSerie, fecha: original.fecha }];
      } else {
        // Issued before the salon switched VERI*FACTU on: it has no record,
        // and the AEAT only needs its identification. The rectificativa is
        // an ordinary new record of the chain. Without a recipient the AEAT
        // can take, it is corrected as one that names nobody.
        const old = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.rectifiesInvoiceId } });
        tipoFactura = identifies(format.recipientId(old.recipientTaxId)) ? "R1" : "R5";
        rectified = [
          {
            nif: format.nif(old.issuerTaxIdAtIssue) ?? ctx.nif,
            numSerie: format.invoiceNumber(old.series, old.number),
            fecha: recordDate(old.issueDate, ctx.timeZone),
          },
        ];
      }
    } else {
      // A ticket is valid without the client's NIF: one that does not check
      // leaves it as a plain simplificada, and never stops a sale at the till.
      if (recipient.kind === "invalid" && !ticket) {
        throw new BadRequestException(
          `El NIF del cliente "${invoice.recipientTaxId}" no es válido. Si es un documento extranjero y no un NIF español, déjalo fuera de este campo.`,
        );
      }
      // F2 is also the invoice "sin identificación del destinatario": a
      // passport or foreign document has no country to go with it (IDOtro),
      // and is never sent as a NIF. It stays on the invoice itself.
      tipoFactura = identifies(recipient) ? "F1" : "F2";
      if (tipoFactura === "F2" && Math.abs(invoice.totalCents) > SIMPLIFIED_LIMIT_CENTS) {
        throw new BadRequestException(
          recipient.kind === "foreign"
            ? "Una factura de más de 3.000 € tiene que identificar al cliente: con Verifactu, indica un NIF español o un NIF-IVA de la UE con su prefijo de país (por ejemplo DE123456789). Un pasaporte u otro documento extranjero no sirve aquí, porque la AEAT pide el país."
            : "Una factura de más de 3.000 € tiene que ser completa: añade el nombre y el NIF del cliente.",
        );
      }
    }
    const withRecipient = tipoFactura === "F1" || tipoFactura === "R1";
    // A ticket naming the client with her NIF (RD 1619/2012 art. 7.2) goes as F1, flagged.
    const simplifiedWithRecipient = ticket && tipoFactura === "F1";
    if (withRecipient && !identifies(recipient)) throw new BadRequestException("Esta factura necesita el NIF del cliente");

    const breakdown = (invoice.taxBreakdown as Array<{ rate: number; baseCents: number; taxCents: number }>) ?? [];
    if (breakdown.length < 1 || breakdown.length > 12) {
      throw new BadRequestException("Una factura Verifactu lleva entre 1 y 12 tipos de impuesto");
    }
    const zeroOperation = zeroRateIsChosen(ctx.zeroRate) ? ctx.zeroRate : ZERO_RATE_FALLBACK;
    const zeroRateAssumed = !zeroRateIsChosen(ctx.zeroRate) && breakdown.some((t) => Number(t.rate) === 0);
    const desglose: TaxLine[] = breakdown.map((t) => ({
      impuesto: TAX_CODE[ctx.taxRegime],
      operation: Number(t.rate) === 0 ? zeroOperation : undefined,
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
      simplifiedWithRecipient,
      recipient: withRecipient ? recipientOf(invoice.recipientName, recipient) : undefined,
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
        zeroRateAssumed,
      },
    };
  }

  // ---- Chain -----------------------------------------------------------------

  private async lockChain(tx: Tx, tenantId: string) {
    await this.lockSalon(tx, tenantId);
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { id: true, name: true, legalName: true, taxId: true, timezone: true, fiscalSettings: true },
    });
    const nif = format.nif(tenant.taxId);
    if (!nif) throw new BadRequestException("Configura el NIF del salón en los ajustes fiscales antes de facturar con Verifactu");
    const chain =
      (await tx.verifactuChain.findUnique({ where: { tenantId } })) ??
      (await tx.verifactuChain.create({ data: { tenantId, installationNumber: installationNumberFor(tenantId) } }));
    const settings = (tenant.fiscalSettings as Record<string, unknown>) ?? {};
    const system: SystemInstallation = {
      producer: producer(),
      installationNumber: chain.installationNumber,
      userHasSeveralTaxpayers: false,
    };
    return {
      tenantId,
      nif,
      issuerName: format.text(tenant.legalName || tenant.name, 120),
      timeZone: tenant.timezone || DEFAULT_SALON_TIMEZONE,
      taxRegime: taxRegimeOf(settings),
      zeroRate: zeroRateTreatmentOf(settings),
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
      zeroRateAssumed?: boolean;
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
        zeroRateAssumed: r.zeroRateAssumed ?? false,
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

/**
 * Whether the AEAT holds, or is about to get, an alta of this invoice: one
 * answered as registered, or still queued (it goes first, in chain order).
 */
function holdsAlta(records: VerifactuRecord[]): boolean {
  return records.some((r) => r.kind === VerifactuRecordKind.alta && r.status !== VerifactuRecordStatus.rejected);
}

/** Whether this identifier can name the recipient of a record. */
function identifies(id: format.RecipientId): id is Extract<format.RecipientId, { kind: "nif" | "vat" }> {
  return id.kind === "nif" || id.kind === "vat";
}

function recipientOf(name: string, id: format.RecipientId): AltaRecord["recipient"] {
  if (!identifies(id)) return undefined;
  const nombre = format.text(name, 120);
  return id.kind === "nif" ? { name: nombre, nif: id.nif } : { name: nombre, otro: id.otro };
}

/** The Impuesto of the record per the salon's regime: 01 IVA, 02 IPSI, 03 IGIC. */
const TAX_CODE = { iva: "01", ipsi: "02", igic: "03" } as const;

/** An invoice's date for a record: "dd-mm-yyyy" of its day (older invoices stored an instant of it). */
function recordDate(issueDate: Date, timeZone: string): string {
  const [y, m, d] = dayOfIssueDate(issueDate, timeZone).split("-");
  return `${d}-${m}-${y}`;
}

/** NumeroInstalacion: one per salon, never reused (FAQ desarrolladores §4). */
export function installationNumberFor(tenantId: string): string {
  return `KR-${tenantId}`;
}
