import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
// @ts-ignore - papaparse lacks bundled types in some setups
import * as Papa from "papaparse";
import { ImportStatus, ImportType } from "@prisma/client";

interface ParsedClientRow {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: string;
  notes?: string;
  _action: "insert" | "update" | "skip";
}

export interface PreviewRow {
  rowIndex: number;
  data: ParsedClientRow;
  errors: { col: string; msg: string }[];
  status: "ok" | "duplicate" | "invalid";
  existingClientId?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[1-9]\d{6,14}$/;

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(private prisma: PrismaService) {}

  async dryRunClients(tenantId: string, csvText: string, filename: string) {
    const rows = this.parseCsv(csvText);
    const preview: PreviewRow[] = [];
    const emails = new Set<string>();
    const stats = {
      totalRows: rows.length,
      okCount: 0,
      duplicateCount: 0,
      invalidCount: 0,
      errors: [] as { row: number; fields: { col: string; msg: string }[] }[],
    };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const parsed = this.normalizeClientRow(r);
      const rowErrors = this.validateClientRow(parsed);
      const status: PreviewRow["status"] =
        rowErrors.length > 0 ? "invalid" : emails.has(parsed.email.toLowerCase())
          ? "duplicate"
          : "ok";
      emails.add(parsed.email.toLowerCase());
      if (status === "ok") stats.okCount++;
      else if (status === "duplicate") stats.duplicateCount++;
      else stats.invalidCount++;
      if (rowErrors.length > 0) {
        stats.errors.push({ row: i + 2, fields: rowErrors });
      }
      let existingId: string | undefined;
      if (parsed.email) {
        const existing = await this.prisma.client.findFirst({
          where: { tenantId, email: parsed.email.toLowerCase() },
          select: { id: true },
        });
        if (existing) existingId = existing.id;
      }
      preview.push({
        rowIndex: i + 2,
        data: parsed,
        errors: rowErrors,
        status,
        existingClientId: existingId,
      });
    }
    const job = await this.prisma.importJob.create({
      data: {
        tenantId,
        type: ImportType.clients,
        status: ImportStatus.completed,
        filename,
        totalRows: rows.length,
        successRows: stats.okCount,
        errorRows: stats.invalidCount,
        errors: stats.errors as any,
        dryRun: true,
        completedAt: new Date(),
      },
    });
    return {
      jobId: job.id,
      filename,
      preview: preview.slice(0, 50),
      stats: {
        totalRows: stats.totalRows,
        okCount: stats.okCount,
        duplicateCount: stats.duplicateCount,
        invalidCount: stats.invalidCount,
      },
      errors: stats.errors,
    };
  }

  async commitClients(tenantId: string, csvText: string, filename: string) {
    const rows = this.parseCsv(csvText);
    let success = 0;
    let errors = 0;
    let skipped = 0;
    const errorsList: { row: number; fields: { col: string; msg: string }[] }[] = [];
    const emails = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const parsed = this.normalizeClientRow(rows[i]);
      const rowErrors = this.validateClientRow(parsed);
      if (rowErrors.length > 0) {
        errors++;
        errorsList.push({ row: i + 2, fields: rowErrors });
        continue;
      }
      const emailKey = parsed.email.toLowerCase();
      if (emails.has(emailKey)) {
        skipped++;
        continue;
      }
      emails.add(emailKey);
      const existing = await this.prisma.client.findFirst({
        where: { tenantId, email: emailKey },
        select: { id: true },
      });
      if (existing && parsed._action === "skip") {
        skipped++;
        continue;
      }
      try {
        if (existing && parsed._action === "update") {
          await this.prisma.client.update({
            where: { id: existing.id },
            data: {
              firstName: parsed.firstName,
              lastName: parsed.lastName,
              phone: parsed.phone || null,
              dateOfBirth: parsed.dateOfBirth
                ? new Date(parsed.dateOfBirth)
                : null,
              notes: parsed.notes || null,
            },
          });
        } else if (!existing) {
          await this.prisma.client.create({
            data: {
              tenantId,
              firstName: parsed.firstName,
              lastName: parsed.lastName,
              email: emailKey,
              phone: parsed.phone || null,
              dateOfBirth: parsed.dateOfBirth
                ? new Date(parsed.dateOfBirth)
                : null,
              notes: parsed.notes || null,
              status: "active",
            },
          });
        }
        success++;
      } catch (err: any) {
        errors++;
        errorsList.push({
          row: i + 2,
          fields: [{ col: "db", msg: err.message ?? "db error" }],
        });
      }
    }
    const job = await this.prisma.importJob.create({
      data: {
        tenantId,
        type: ImportType.clients,
        status: ImportStatus.completed,
        filename,
        totalRows: rows.length,
        successRows: success,
        errorRows: errors,
        errors: errorsList as any,
        dryRun: false,
        completedAt: new Date(),
      },
    });
    return {
      jobId: job.id,
      totalRows: rows.length,
      successRows: success,
      errorRows: errors,
      skippedRows: skipped,
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
      "firstName,lastName,email,phone,dateOfBirth,gender,notes,_action",
      "María,García,maria@example.com,+34612345678,1990-05-12,female,Cliente VIP,insert",
      "Pedro,López,pedro@example.com,+34698765432,1985-11-02,male,,skip",
    ].join("\n");
  }

  private parseCsv(csvText: string): Record<string, string>[] {
    if (!csvText || !csvText.trim()) {
      throw new BadRequestException("CSV is empty");
    }
    const result = Papa.parse<Record<string, string>>(csvText.trim(), {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h: string) => h.trim(),
      dynamicTyping: false,
    });
    if (result.errors && result.errors.length > 0) {
      this.logger.warn(`CSV parse warnings: ${JSON.stringify(result.errors)}`);
    }
    return (result.data ?? []).filter((r) =>
      Object.values(r).some((v) => (v ?? "").toString().trim().length > 0),
    );
  }

  private normalizeClientRow(row: Record<string, string>): ParsedClientRow {
    return {
      firstName: (row.firstName ?? row.first_name ?? "").toString().trim(),
      lastName: (row.lastName ?? row.last_name ?? "").toString().trim(),
      email: (row.email ?? "").toString().trim().toLowerCase(),
      phone: (row.phone ?? "").toString().trim() || undefined,
      dateOfBirth: (row.dateOfBirth ?? row.date_of_birth ?? "").toString().trim() || undefined,
      gender: (row.gender ?? "").toString().trim() || undefined,
      notes: (row.notes ?? "").toString().trim() || undefined,
      _action: ((row._action ?? "insert").toString().trim().toLowerCase() as ParsedClientRow["_action"]) || "insert",
    };
  }

  private validateClientRow(
    row: ParsedClientRow,
  ): { col: string; msg: string }[] {
    const errors: { col: string; msg: string }[] = [];
    if (!row.firstName) errors.push({ col: "firstName", msg: "Required" });
    if (!row.lastName) errors.push({ col: "lastName", msg: "Required" });
    if (!row.email) errors.push({ col: "email", msg: "Required" });
    else if (!EMAIL_RE.test(row.email)) errors.push({ col: "email", msg: "Invalid format" });
    if (row.phone && !PHONE_RE.test(row.phone.replace(/\s/g, ""))) {
      errors.push({ col: "phone", msg: "Must be E.164 (e.g. +34612345678)" });
    }
    if (row.dateOfBirth && isNaN(new Date(row.dateOfBirth).getTime())) {
      errors.push({ col: "dateOfBirth", msg: "Invalid date" });
    }
    if (row._action && !["insert", "update", "skip"].includes(row._action)) {
      errors.push({ col: "_action", msg: "Must be insert|update|skip" });
    }
    return errors;
  }
}