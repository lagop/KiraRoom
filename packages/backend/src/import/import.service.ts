import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
// @ts-ignore - papaparse lacks bundled types in some setups
import * as Papa from "papaparse";
import { ImportStatus, ImportType, Prisma } from "@prisma/client";
import { phoneKey } from "../common/phone";
import {
  ClientRow,
  ServiceRow,
  clientRowErrors,
  readClientRows,
  readServiceRows,
  serviceRowErrors,
} from "./columns";

type RowErrors = { col: string; msg: string }[];

export interface PreviewRow {
  rowIndex: number;
  data: ClientRow | ServiceRow;
  errors: RowErrors;
  status: "ok" | "duplicate" | "invalid" | "update";
  existingId?: string;
}

/**
 * Imports clients and services from a CSV: KiraRoom's template or another
 * program's export (see columns.ts). Every import can be previewed first
 * (dry run) and leaves an ImportJob row.
 *
 * Clients are matched against the salon's existing ones and against earlier
 * rows of the same file by email or by phone (last nine digits), so an
 * export with the same person twice, or a client already in KiraRoom, is not
 * duplicated. Services are matched by name.
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(private prisma: PrismaService) {}

  // ---- Clients ------------------------------------------------------------

  async dryRunClients(tenantId: string, csvText: string, filename: string) {
    return this.importClients(tenantId, csvText, filename, true);
  }

  async commitClients(tenantId: string, csvText: string, filename: string) {
    return this.importClients(tenantId, csvText, filename, false);
  }

  private async importClients(tenantId: string, csvText: string, filename: string, dryRun: boolean) {
    const raw = this.parseCsv(csvText);
    const country = await this.tenantCountry(tenantId);
    const rows = readClientRows(raw, country);
    const known = await this.clientIndex(tenantId);
    const seen = new Set<string>();
    const preview: PreviewRow[] = [];
    const errors: { row: number; fields: RowErrors }[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const tally: Record<PreviewRow["status"], number> = { ok: 0, update: 0, duplicate: 0, invalid: 0 };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowIndex = i + 2;
      const dateColumn = Object.keys(raw[i]).find((k) => /nacim|birth|cumple/i.test(k));
      const rowErrors = clientRowErrors(row, dateColumn ? String(raw[i][dateColumn] ?? "").trim() : undefined);
      const keys = [row.email ? `e:${row.email}` : null, row.phone ? `p:${phoneKey(row.phone)}` : null].filter(
        Boolean,
      ) as string[];
      const existingId = keys.map((k) => known.get(k)).find(Boolean);
      const repeated = keys.some((k) => seen.has(k));

      let status: PreviewRow["status"];
      if (rowErrors.length > 0) status = "invalid";
      else if (repeated) status = "duplicate";
      else if (existingId) status = row.action === "update" ? "update" : "duplicate";
      else status = "ok";
      keys.forEach((k) => seen.add(k));
      if (rowErrors.length > 0) errors.push({ row: rowIndex, fields: rowErrors });
      tally[status]++;
      if (preview.length < 50) preview.push({ rowIndex, data: row, errors: rowErrors, status, existingId });

      if (dryRun || status === "invalid") continue;
      if (status === "duplicate" || row.action === "skip") {
        skipped++;
        continue;
      }
      try {
        const data = {
          firstName: row.firstName,
          lastName: row.lastName,
          phone: row.phone ?? null,
          dateOfBirth: row.dateOfBirth ? new Date(row.dateOfBirth) : null,
          notes: row.notes ?? null,
        };
        if (status === "update" && existingId) {
          await this.prisma.client.update({
            where: { id: existingId },
            data: { ...data, ...(row.email ? { email: row.email } : {}) },
          });
          updated++;
        } else {
          const client = await this.prisma.client.create({
            data: { tenantId, ...data, email: row.email ?? null, status: "active", source: "import" } as any,
            select: { id: true },
          });
          keys.forEach((k) => known.set(k, client.id));
          created++;
        }
      } catch (err: any) {
        errors.push({ row: rowIndex, fields: [{ col: "base de datos", msg: err.message ?? "error" }] });
      }
    }

    return this.finish(tenantId, ImportType.clients, filename, dryRun, rows.length, preview, errors, tally, {
      created,
      updated,
      skipped,
    });
  }

  /** The salon's clients by email and by phone (last nine digits). */
  private async clientIndex(tenantId: string): Promise<Map<string, string>> {
    const clients = await this.prisma.client.findMany({
      where: { tenantId },
      select: { id: true, email: true, phone: true },
    });
    const index = new Map<string, string>();
    for (const c of clients) {
      if (c.email) index.set(`e:${c.email.toLowerCase()}`, c.id);
      if (c.phone && phoneKey(c.phone)) index.set(`p:${phoneKey(c.phone)}`, c.id);
    }
    return index;
  }

  // ---- Services -----------------------------------------------------------

  async dryRunServices(tenantId: string, csvText: string, filename: string) {
    return this.importServices(tenantId, csvText, filename, true);
  }

  async commitServices(tenantId: string, csvText: string, filename: string) {
    return this.importServices(tenantId, csvText, filename, false);
  }

  private async importServices(tenantId: string, csvText: string, filename: string, dryRun: boolean) {
    const rows = readServiceRows(this.parseCsv(csvText));
    const existing = await this.prisma.service.findMany({ where: { tenantId }, select: { id: true, name: true } });
    const byName = new Map(existing.map((s) => [s.name.trim().toLowerCase(), s.id]));
    const seen = new Set<string>();
    const preview: PreviewRow[] = [];
    const errors: { row: number; fields: RowErrors }[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const tally: Record<PreviewRow["status"], number> = { ok: 0, update: 0, duplicate: 0, invalid: 0 };

    for (let i = 0; i < rows.length; i++) {
      const { row, raw } = rows[i];
      const rowIndex = i + 2;
      const rowErrors = serviceRowErrors(row, raw);
      const key = row.name.toLowerCase();
      const existingId = byName.get(key);
      let status: PreviewRow["status"];
      if (rowErrors.length > 0) status = "invalid";
      else if (seen.has(key)) status = "duplicate";
      else status = existingId ? "update" : "ok";
      seen.add(key);
      if (rowErrors.length > 0) errors.push({ row: rowIndex, fields: rowErrors });
      tally[status]++;
      if (preview.length < 50) preview.push({ rowIndex, data: row, errors: rowErrors, status, existingId });

      if (dryRun || status === "invalid") continue;
      if (status === "duplicate") {
        skipped++;
        continue;
      }
      try {
        const data = {
          duration: row.duration!,
          price: new Prisma.Decimal(row.price!),
          category: row.category,
          ...(row.description ? { description: row.description } : {}),
        };
        if (existingId) {
          await this.prisma.service.update({ where: { id: existingId }, data });
          updated++;
        } else {
          const service = await this.prisma.service.create({
            data: { tenantId, name: row.name, ...data },
            select: { id: true },
          });
          byName.set(key, service.id);
          created++;
        }
      } catch (err: any) {
        errors.push({ row: rowIndex, fields: [{ col: "base de datos", msg: err.message ?? "error" }] });
      }
    }

    return this.finish(tenantId, ImportType.services, filename, dryRun, rows.length, preview, errors, tally, {
      created,
      updated,
      skipped,
    });
  }

  // ---- Shared -------------------------------------------------------------

  private async finish(
    tenantId: string,
    type: ImportType,
    filename: string,
    dryRun: boolean,
    totalRows: number,
    preview: PreviewRow[],
    errors: { row: number; fields: RowErrors }[],
    tally: Record<PreviewRow["status"], number>,
    counts: { created: number; updated: number; skipped: number },
  ) {
    const invalidCount = errors.length;
    const job = await this.prisma.importJob.create({
      data: {
        tenantId,
        type,
        status: ImportStatus.completed,
        filename,
        totalRows,
        successRows: dryRun ? totalRows - invalidCount : counts.created + counts.updated,
        errorRows: invalidCount,
        errors: errors as any,
        dryRun,
        completedAt: new Date(),
      },
    });
    return {
      jobId: job.id,
      filename,
      preview,
      stats: {
        totalRows,
        okCount: tally.ok,
        updateCount: tally.update,
        duplicateCount: tally.duplicate,
        invalidCount,
      },
      errors,
      // Commit results (zero on a dry run).
      totalRows,
      successRows: counts.created + counts.updated,
      createdRows: counts.created,
      updatedRows: counts.updated,
      skippedRows: counts.skipped,
      errorRows: invalidCount,
    };
  }

  async listJobs(tenantId: string) {
    return this.prisma.importJob.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  getClientTemplate(): string {
    return [
      "Nombre,Apellidos,Teléfono,Email,Fecha de nacimiento,Notas",
      "María,García López,612 345 678,maria@example.com,12/05/1990,Prefiere las mañanas",
      "Pedro,Ruiz,698 765 432,,,",
    ].join("\n");
  }

  getServiceTemplate(): string {
    return [
      "Servicio,Duración,Precio,Categoría,Descripción",
      "Corte mujer,45 min,25,Peluquería,Lavado y corte",
      "Manicura semipermanente,1 h,22,Uñas,",
    ].join("\n");
  }

  private async tenantCountry(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { country: true } });
    return (tenant?.country || "ES").toUpperCase();
  }

  private parseCsv(csvText: string): Record<string, string>[] {
    if (!csvText || !csvText.trim()) {
      throw new BadRequestException("El archivo está vacío");
    }
    // Strip a UTF-8 BOM (Excel adds one); the delimiter (, or ;) is detected.
    const result = Papa.parse<Record<string, string>>(csvText.replace(/^\uFEFF/, "").trim(), {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h: string) => h.trim(),
      dynamicTyping: false,
    });
    if (result.errors && result.errors.length > 0) {
      this.logger.warn(`CSV parse warnings: ${JSON.stringify(result.errors.slice(0, 5))}`);
    }
    const rows = (result.data ?? []).filter((r) =>
      Object.values(r).some((v) => (v ?? "").toString().trim().length > 0),
    );
    if (rows.length > 5000) {
      throw new BadRequestException("El archivo tiene más de 5.000 filas: divídelo en varios.");
    }
    return rows;
  }
}
