import { Injectable, BadRequestException, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
// @ts-ignore - papaparse lacks bundled types in some setups
import * as Papa from "papaparse";
import {
  AppointmentSource,
  AppointmentStatus,
  ImportStatus,
  ImportType,
  PaymentStatus,
  Prisma,
} from "@prisma/client";
import { phoneKey } from "../common/phone";
import { salonInstant } from "../appointments/salon-time";
import {
  ClientRow,
  ServiceRow,
  ReadInfo,
  clientRowErrors,
  nameCandidates,
  nameKey,
  nameMatches,
  sameName,
  readAppointmentRows,
  readClientRows,
  readServiceRows,
  serviceRowErrors,
} from "./columns";
import { MAX_CELL_CHARS, readXlsxRows, SpreadsheetError } from "./spreadsheet";
import { appointmentLocations } from "../multi-location/appointment-location";
import { ConsentService } from "../consent/consent.service";

/** The uploaded file: CSV text, or the bytes of an .xlsx (its first sheet is read). */
export type ImportFile = string | { xlsx: Buffer };

type RowErrors = { col: string; msg: string }[];

/** One appointment row as the preview shows it: what it matched. */
export interface AppointmentPreview {
  date?: string;
  time?: string;
  clientName: string;
  service: string;
  professional: string;
}

export interface PreviewRow {
  rowIndex: number;
  data: ClientRow | ServiceRow | AppointmentPreview;
  errors: RowErrors;
  /** skip: left out on purpose (an appointment already past or cancelled). */
  status: "ok" | "duplicate" | "invalid" | "update" | "skip";
  existingId?: string;
  note?: string;
}

export interface AppointmentImportOptions {
  /** false: mark the reminders as sent (the old program may still send its own). */
  sendReminders?: boolean;
}

/** An appointment's identity for "already in the agenda". */
function slotKey(professionalId: string, date: Date | string, time: string, client: string): string {
  const day = typeof date === "string" ? date.slice(0, 10) : date.toISOString().slice(0, 10);
  return `${professionalId}|${day}|${time}|${client}`;
}

function ambiguous(text: string, names: string[]): string {
  const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "");
  return `"${text}" puede ser varios (${shown}): pon el nombre completo en el archivo`;
}

/**
 * A client's notes after an import with action=update: the file's notes are
 * added after the ones she has (a blank line between), not written over
 * them; nothing changes when the file has none or they are already there.
 */
export function mergeNotes(existing: string | null | undefined, incoming: string | null | undefined): string | null {
  const before = (existing ?? "").trim();
  const added = (incoming ?? "").trim();
  if (!added) return before || null;
  if (!before) return added;
  if (before.includes(added)) return before;
  return `${before}\n\n${added}`;
}

/**
 * One row that was not imported: where and why, and the row as it came in
 * the file (only in the response, for "Descargar filas con errores"; the
 * import job keeps the reasons, not the client's data).
 */
export interface ImportError {
  row: number;
  fields: RowErrors;
  data?: Record<string, unknown>;
}

/** Clients by contact key ("e:<email>", "p:<last nine digits>"), with their names. */
type IndexedClient = { id: string; firstName: string; lastName: string | null };
type ClientIndex = Map<string, IndexedClient[]>;

function contactKeys(c: { email?: string | null; phone?: string | null }): string[] {
  const keys: string[] = [];
  if (c.email) keys.push(`e:${c.email.toLowerCase()}`);
  if (c.phone && phoneKey(c.phone)) keys.push(`p:${phoneKey(c.phone)}`);
  return keys;
}

function indexClient(index: ClientIndex, keys: string[], c: IndexedClient): void {
  for (const k of keys) index.set(k, [...(index.get(k) ?? []), c]);
}

/**
 * The client this row is: the one with its email, else one with its phone
 * and the same name (sameName). A phone shared with someone of another name
 * is a relative's (a mother gives hers for her daughter), so no match, and
 * `sharesPhoneWith` names who has it (O7).
 */
function findClient(
  index: ClientIndex,
  row: { email?: string | null; phone?: string | null; firstName: string; lastName?: string | null },
): { id?: string; sharesPhoneWith?: string } {
  if (row.email) {
    const byEmail = index.get(`e:${row.email.toLowerCase()}`);
    if (byEmail?.length) return { id: byEmail[0].id };
  }
  const key = row.phone ? phoneKey(row.phone) : null;
  if (!key) return {};
  const byPhone = index.get(`p:${key}`) ?? [];
  const same = byPhone.find((c) => sameName(c, row));
  if (same) return { id: same.id };
  const other = byPhone[0];
  return other ? { sharesPhoneWith: `${other.firstName} ${other.lastName ?? ""}`.trim() } : {};
}

/**
 * A database failure as the salon can read it: it used to be Prisma's own
 * text, in English (O8). The detail is logged.
 */
export function dbErrorMessage(err: unknown, kind: "client" | "service" | "appointment"): string {
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e?.code === "P2002") {
    const target = String(e.meta?.target ?? "");
    if (/email/i.test(target)) return "Ese email ya lo tiene otra clienta.";
    if (kind === "service") return "Ya hay un servicio con ese nombre.";
    return "Ya existe un registro con esos mismos datos.";
  }
  if (e?.code === "P2000") return "Un dato es demasiado largo para guardarlo.";
  if (e?.code === "P2003" || e?.code === "P2025") {
    return kind === "appointment"
      ? "El servicio, la profesional o la clienta ya no existe."
      : "Un dato relacionado ya no existe.";
  }
  return "No se ha podido guardar esta fila. Revísala e inténtalo de nuevo.";
}

/** The file-wide notices (see ReadInfo). */
function readWarnings(info: ReadInfo, what: string): string[] {
  return info.monthFirst
    ? [
        `Las ${what} del archivo están en formato mes/día (americano): las hemos leído así. Revisa en la vista previa que salen bien.`,
      ]
    : [];
}

/** "10:30" + 45 -> "11:15" (wraps past midnight). */
function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Imports clients, services and appointments from a CSV or an .xlsx (see
 * spreadsheet.ts): KiraRoom's template or another program's export (see
 * columns.ts). Every import can be previewed first (dry run) and leaves an
 * ImportJob row.
 *
 * Clients are matched against the salon's existing ones and against earlier
 * rows of the same file by email or by phone (last nine digits), so an
 * export with the same person twice, or a client already in KiraRoom, is not
 * duplicated. Services are matched by name.
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() private readonly consent?: ConsentService,
  ) {}

  // ---- Clients ------------------------------------------------------------

  async dryRunClients(tenantId: string, file: ImportFile, filename: string) {
    return this.importClients(tenantId, file, filename, true);
  }

  /** `actorId`: who imports (kept on the marketing refusals the file records). */
  async commitClients(tenantId: string, file: ImportFile, filename: string, actorId?: string) {
    return this.importClients(tenantId, file, filename, false, actorId);
  }

  private async importClients(
    tenantId: string,
    file: ImportFile,
    filename: string,
    dryRun: boolean,
    actorId?: string,
  ) {
    const raw = await this.readRows(file);
    const country = await this.tenantCountry(tenantId);
    const info: ReadInfo = {};
    const rows = readClientRows(raw, country, info);
    const known = await this.clientIndex(tenantId);
    // The file's earlier rows, the same way.
    const seen: ClientIndex = new Map();
    const preview: PreviewRow[] = [];
    const errors: ImportError[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let marketingRefusals = 0;
    const tally: Record<PreviewRow["status"], number> = { ok: 0, update: 0, duplicate: 0, invalid: 0, skip: 0 };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowIndex = i + 2;
      const dateColumn = Object.keys(raw[i]).find((k) => /nacim|birth|cumple/i.test(k));
      const rowErrors = clientRowErrors(row, dateColumn ? String(raw[i][dateColumn] ?? "").trim() : undefined);
      const keys = contactKeys(row);
      // The same person: the same email, or the same phone AND the same
      // name. A mother who gives her phone for her daughter is two clients
      // (O7): the second row used to be dropped as "Ya existe".
      const existing = findClient(known, row);
      const repeated = findClient(seen, row);
      const existingId = existing.id;
      const sharesWith = existingId || repeated.id ? undefined : (existing.sharesPhoneWith ?? repeated.sharesPhoneWith);

      let status: PreviewRow["status"];
      if (rowErrors.length > 0) status = "invalid";
      else if (repeated.id) status = "duplicate";
      else if (existingId) status = row.action === "update" ? "update" : "duplicate";
      else status = "ok";
      if (!repeated.id) indexClient(seen, keys, { id: `row-${rowIndex}`, firstName: row.firstName, lastName: row.lastName });
      if (rowErrors.length > 0) errors.push({ row: rowIndex, fields: rowErrors, data: raw[i] });
      tally[status]++;
      // A "no" to advertising is recorded for the client the row is, new or
      // already in KiraRoom (not for a row left out on purpose, nor for the
      // same person's second row in the file: the first one decides).
      const refuses = row.marketing === "no" && status !== "invalid" && row.action !== "skip" && !repeated.id;
      const sharedNote = status === "ok" && sharesWith ? `Comparte teléfono con ${sharesWith}: se crea como clienta aparte` : undefined;
      const note =
        [sharedNote, refuses ? "No acepta publicidad: se guardará en su ficha" : undefined].filter(Boolean).join(" · ") ||
        undefined;
      if (preview.length < 50) preview.push({ rowIndex, data: row, errors: rowErrors, status, existingId, note });

      if (dryRun || status === "invalid") continue;
      if (status === "duplicate" || row.action === "skip") {
        skipped++;
        if (refuses && existingId && (await this.recordMarketingRefusal(tenantId, existingId, actorId))) {
          marketingRefusals++;
        }
        continue;
      }
      try {
        let clientId: string;
        if (status === "update" && existingId) {
          // An empty cell keeps what the client has: an export with no
          // phone or birthday for her is not a reason to erase hers. Notes
          // are added to hers, not written over them.
          const current = await this.prisma.client.findFirst({
            where: { id: existingId, tenantId },
            select: { notes: true },
          });
          await this.prisma.client.update({
            where: { id: existingId },
            data: {
              firstName: row.firstName,
              ...(row.lastName ? { lastName: row.lastName } : {}),
              ...(row.phone ? { phone: row.phone } : {}),
              ...(row.dateOfBirth ? { dateOfBirth: new Date(row.dateOfBirth) } : {}),
              ...(row.notes ? { notes: mergeNotes(current?.notes, row.notes) } : {}),
              ...(row.email ? { email: row.email } : {}),
            },
          });
          clientId = existingId;
          updated++;
        } else {
          const client = await this.prisma.client.create({
            data: {
              tenantId,
              firstName: row.firstName,
              lastName: row.lastName,
              phone: row.phone ?? null,
              dateOfBirth: row.dateOfBirth ? new Date(row.dateOfBirth) : null,
              // Who she shares the phone with, so the salon knows why two
              // clients have the same number.
              notes: mergeNotes(row.notes, sharesWith ? `Comparte teléfono con ${sharesWith}.` : null),
              email: row.email ?? null,
              status: "active",
              source: "import",
            } as any,
            select: { id: true },
          });
          indexClient(known, keys, { id: client.id, firstName: row.firstName, lastName: row.lastName });
          clientId = client.id;
          created++;
        }
        if (refuses && (await this.recordMarketingRefusal(tenantId, clientId, actorId))) marketingRefusals++;
      } catch (err: any) {
        this.logger.warn(`import clients row ${rowIndex}: ${err?.message}`);
        errors.push({ row: rowIndex, fields: [{ col: "base de datos", msg: dbErrorMessage(err, "client") }], data: raw[i] });
      }
    }

    const result = await this.finish(tenantId, ImportType.clients, filename, dryRun, rows.length, preview, errors, tally, {
      created,
      updated,
      skipped,
    });
    return { ...result, marketingRefusals, warnings: readWarnings(info, "fechas de nacimiento") };
  }

  /**
   * The old program says the client does not accept advertising: recorded
   * as her refusal of commercial communications, through the same consent
   * record as a "no" from her account, marked as recorded by the salon (who
   * imported). Campaigns then leave her out. Nothing is sent.
   *
   * A "yes" is not recorded: an acceptance is the client's own act, with
   * the wording she saw, and the file cannot show either. (Without a
   * record, email campaigns still reach existing clients, as before.)
   *
   * Never fails the import; returns whether it was recorded.
   */
  private async recordMarketingRefusal(tenantId: string, clientId: string, actorId?: string): Promise<boolean> {
    if (!this.consent) return false;
    try {
      await this.consent.recordMarketingChoice({
        tenantId,
        clientId,
        accepts: false,
        channel: "email",
        recordedBy: actorId ?? "import",
      });
      return true;
    } catch (err) {
      this.logger.warn(`marketing refusal of imported client ${clientId} not recorded: ${(err as Error).message}`);
      return false;
    }
  }

  /** The salon's clients by email and by phone (last nine digits), with their names. */
  private async clientIndex(tenantId: string): Promise<ClientIndex> {
    const clients = await this.prisma.client.findMany({
      where: { tenantId },
      select: { id: true, email: true, phone: true, firstName: true, lastName: true },
    });
    const index: ClientIndex = new Map();
    for (const c of clients) indexClient(index, contactKeys(c), c);
    return index;
  }

  // ---- Services -----------------------------------------------------------

  async dryRunServices(tenantId: string, file: ImportFile, filename: string) {
    return this.importServices(tenantId, file, filename, true);
  }

  async commitServices(tenantId: string, file: ImportFile, filename: string) {
    return this.importServices(tenantId, file, filename, false);
  }

  private async importServices(tenantId: string, file: ImportFile, filename: string, dryRun: boolean) {
    const source = await this.readRows(file);
    const rows = readServiceRows(source);
    const existing = await this.prisma.service.findMany({ where: { tenantId }, select: { id: true, name: true } });
    const byName = new Map(existing.map((s) => [s.name.trim().toLowerCase(), s.id]));
    const seen = new Set<string>();
    const preview: PreviewRow[] = [];
    const errors: ImportError[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const tally: Record<PreviewRow["status"], number> = { ok: 0, update: 0, duplicate: 0, invalid: 0, skip: 0 };

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
      if (rowErrors.length > 0) errors.push({ row: rowIndex, fields: rowErrors, data: source[i] });
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
        this.logger.warn(`import services row ${rowIndex}: ${err?.message}`);
        errors.push({ row: rowIndex, fields: [{ col: "base de datos", msg: dbErrorMessage(err, "service") }], data: source[i] });
      }
    }

    return this.finish(tenantId, ImportType.services, filename, dryRun, rows.length, preview, errors, tally, {
      created,
      updated,
      skipped,
    });
  }

  // ---- Appointments -------------------------------------------------------

  async dryRunAppointments(tenantId: string, file: ImportFile, filename: string, options: AppointmentImportOptions = {}) {
    return this.importAppointments(tenantId, file, filename, true, options);
  }

  async commitAppointments(tenantId: string, file: ImportFile, filename: string, options: AppointmentImportOptions = {}) {
    return this.importAppointments(tenantId, file, filename, false, options);
  }

  /**
   * The salon's upcoming appointments from its previous program, so the
   * switch does not mean typing the agenda in again. Only future ones: the
   * past are history, not bookings. Each row is matched to a service and a
   * professional of the salon by name and to a client by email, phone or
   * name (a new client is created when none matches).
   *
   * Written straight to the database, not through the booking flow: the
   * clients already have these appointments, so no confirmation goes out,
   * and the agenda is copied as it was, without availability checks.
   * Reminders are sent as for any appointment unless the salon turns them off
   * (its old program may still be sending them).
   */
  private async importAppointments(
    tenantId: string,
    file: ImportFile,
    filename: string,
    dryRun: boolean,
    options: AppointmentImportOptions,
  ) {
    const source = await this.readRows(file);
    const info: ReadInfo = {};
    const rows = readAppointmentRows(source, await this.tenantCountry(tenantId), info);
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    const timeZone = tenant?.timezone || "Europe/Madrid";
    const [services, professionals, clients, booked, locations] = await Promise.all([
      this.prisma.service.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true, duration: true, price: true, currency: true },
      }),
      this.prisma.professional.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, firstName: true, lastName: true },
      }),
      this.prisma.client.findMany({
        where: { tenantId },
        select: { id: true, email: true, phone: true, firstName: true, lastName: true },
      }),
      // What is already in the agenda, so importing the same file twice adds nothing.
      this.prisma.appointment.findMany({
        where: {
          tenantId,
          scheduledDate: { gte: new Date(Date.now() - 86_400_000) },
          status: { not: AppointmentStatus.cancelled },
        },
        select: { clientId: true, professionalId: true, scheduledDate: true, scheduledTime: true },
      }),
      // Each professional's location, written on the appointment (multi-location report).
      dryRun ? Promise.resolve(new Map<string, string>()) : appointmentLocations(this.prisma, tenantId),
    ]);
    // By email, and by phone with the name (findClient): the clients this
    // file creates are added as it goes, so their other rows reuse them.
    const contacts: ClientIndex = new Map();
    for (const c of clients) indexClient(contacts, contactKeys(c), c);
    const byName = new Map<string, string[]>();
    for (const c of clients) {
      const key = nameKey(`${c.firstName} ${c.lastName ?? ""}`);
      byName.set(key, [...(byName.get(key) ?? []), c.id]);
    }
    const taken = new Set(booked.map((a) => slotKey(a.professionalId, a.scheduledDate, a.scheduledTime, a.clientId)));
    // The same appointment twice in the file, by the client's name.
    const inFile = new Set<string>();
    // Clients this file creates, by name (for rows with no email or phone).
    const createdByName = new Map<string, string>();

    const preview: PreviewRow[] = [];
    const errors: ImportError[] = [];
    let created = 0;
    let skipped = 0;
    let newClients = 0;
    const tally: Record<PreviewRow["status"], number> = { ok: 0, update: 0, duplicate: 0, invalid: 0, skip: 0 };
    const now = Date.now();

    for (let i = 0; i < rows.length; i++) {
      const { row, raw } = rows[i];
      const rowIndex = i + 2;
      const rowErrors: RowErrors = [];
      if (!row.date) rowErrors.push({ col: "fecha", msg: raw.date ? "Fecha no reconocida" : "Falta la fecha" });
      if (!row.time) rowErrors.push({ col: "hora", msg: raw.time ? "Hora no reconocida" : "Falta la hora" });
      if (!row.firstName) rowErrors.push({ col: "cliente", msg: "Falta el nombre del cliente" });

      const serviceMatch = row.service ? nameMatches(row.service, services, (s) => [s.name]) : { items: [], exact: false };
      const serviceMatches = serviceMatch.items;
      const service = serviceMatches.length === 1 ? serviceMatches[0] : null;
      if (!row.service) rowErrors.push({ col: "servicio", msg: "Falta el servicio" });
      else if (serviceMatches.length > 1) {
        rowErrors.push({ col: "servicio", msg: ambiguous(row.service, serviceMatches.map((s) => s.name)) });
      } else if (!service) {
        rowErrors.push({ col: "servicio", msg: `"${row.service}" no coincide con ningún servicio tuyo (impórtalos o créalos primero)` });
      }

      // With a single professional, a file with no such column is unambiguous.
      const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();
      const proMatches = row.professional
        ? nameCandidates(row.professional, professionals, (p) => [fullName(p), p.firstName])
        : professionals.length === 1
          ? professionals
          : [];
      const professional = proMatches.length === 1 ? proMatches[0] : null;
      if (proMatches.length > 1) {
        rowErrors.push({ col: "profesional", msg: ambiguous(row.professional, proMatches.map(fullName)) });
      } else if (!professional) {
        rowErrors.push({
          col: "profesional",
          msg: row.professional ? `"${row.professional}" no coincide con ningún profesional` : "Falta el profesional",
        });
      }
      if (raw.duration && (!row.duration || row.duration < 5 || row.duration > 600)) {
        rowErrors.push({ col: "duración", msg: "Duración no reconocida (minutos)" });
      }

      // The client: by email, or by phone when the name fits too (a phone
      // shared with a relative of another name is not hers; O7), then by
      // name if only one has it.
      const keys = contactKeys(row);
      const namesakes = byName.get(nameKey(row.clientName)) ?? [];
      const nameId = createdByName.get(nameKey(row.clientName)) ?? (namesakes.length === 1 ? namesakes[0] : undefined);
      // The name only when the row has no email or phone: a row whose
      // contact matches nobody is someone else with the same name (a new
      // client), not the one already called that.
      const match = keys.length > 0 ? findClient(contacts, row) : {};
      const clientId = keys.length > 0 ? match.id : nameId;

      let status: PreviewRow["status"];
      let note: string | undefined;
      const startsAt = row.date && row.time ? salonInstant(row.date, row.time, timeZone) : null;
      const key = professional && row.date && row.time && clientId ? slotKey(professional.id, row.date, row.time, clientId) : null;
      const fileKey =
        professional && row.date && row.time ? slotKey(professional.id, row.date, row.time, nameKey(row.clientName)) : null;
      if (row.cancelled) {
        status = "skip";
        note = "Cancelada en el otro programa";
      } else if (startsAt && startsAt.getTime() < now) {
        status = "skip";
        note = "Ya ha pasado";
      } else if (rowErrors.length > 0) {
        status = "invalid";
      } else if ((key && taken.has(key)) || (fileKey && inFile.has(fileKey))) {
        status = "duplicate";
      } else {
        status = "ok";
        const notes = [
          !clientId ? (match.sharesPhoneWith ? `Cliente nuevo (comparte teléfono con ${match.sharesPhoneWith})` : "Cliente nuevo") : null,
          // "Corte" taken as "Corte y peinado": said, so it can be checked (O16).
          service && !serviceMatch.exact ? `Unida a «${service.name}»` : null,
        ].filter(Boolean);
        note = notes.length > 0 ? notes.join(" · ") : undefined;
      }
      if (key) taken.add(key);
      if (fileKey) inFile.add(fileKey);
      if (status === "ok" && !clientId) {
        newClients++;
        // The dry run creates nothing, but the client's next rows are not new.
        if (dryRun) {
          createdByName.set(nameKey(row.clientName), "(nuevo)");
          indexClient(contacts, keys, { id: "(nuevo)", firstName: row.firstName, lastName: row.lastName });
        }
      }
      if (status === "invalid") errors.push({ row: rowIndex, fields: rowErrors, data: source[i] });
      tally[status]++;
      if (preview.length < 50) {
        preview.push({
          rowIndex,
          data: {
            date: row.date,
            time: row.time,
            clientName: row.clientName,
            service: service?.name ?? row.service,
            professional: professional ? `${professional.firstName} ${professional.lastName}`.trim() : row.professional,
          },
          errors: status === "invalid" ? rowErrors : [],
          status,
          note,
        });
      }

      if (dryRun || status !== "ok") {
        if (!dryRun && (status === "skip" || status === "duplicate")) skipped++;
        continue;
      }
      try {
        let id = clientId;
        if (!id) {
          const client = await this.prisma.client.create({
            data: {
              tenantId,
              firstName: row.firstName,
              lastName: row.lastName,
              email: row.email ?? null,
              phone: row.phone ?? null,
              status: "active",
              source: "import",
            } as any,
            select: { id: true },
          });
          id = client.id;
          createdByName.set(nameKey(row.clientName), id);
          indexClient(contacts, keys, { id, firstName: row.firstName, lastName: row.lastName });
        }
        const duration = row.duration ?? service!.duration;
        const price = row.price ?? Number(service!.price);
        const remindersOff = options.sendReminders === false;
        await this.prisma.appointment.create({
          data: {
            tenantId,
            clientId: id,
            serviceId: service!.id,
            professionalId: professional!.id,
            locationId: locations.get(professional!.id) ?? null,
            scheduledDate: new Date(row.date!),
            scheduledTime: row.time!,
            startTime: startsAt,
            duration,
            endTime: addMinutes(row.time!, duration),
            status: AppointmentStatus.confirmed,
            price: new Prisma.Decimal(price),
            totalAmount: Math.round(price * 100), // cents, as insertAppointment stores it
            currency: service!.currency,
            // What it was booked at: the other program's price and length
            // when the file has them (appointment-snapshot.ts).
            serviceName: service!.name,
            servicePrice: new Prisma.Decimal(price),
            serviceDuration: duration,
            paymentStatus: PaymentStatus.pending,
            notes: row.notes ?? null,
            internalNotes: `Importada de ${filename}`,
            source: AppointmentSource.staff,
            reminder24hSent: remindersOff,
            reminder1hSent: remindersOff,
          },
        });
        created++;
      } catch (err: any) {
        this.logger.warn(`import appointments row ${rowIndex}: ${err?.message}`);
        errors.push({
          row: rowIndex,
          fields: [{ col: "base de datos", msg: dbErrorMessage(err, "appointment") }],
          data: source[i],
        });
      }
    }

    const result = await this.finish(tenantId, ImportType.appointments, filename, dryRun, rows.length, preview, errors, tally, {
      created,
      updated: 0,
      skipped,
    });
    return { ...result, newClients, warnings: readWarnings(info, "fechas") };
  }

  // ---- Shared -------------------------------------------------------------

  private async finish(
    tenantId: string,
    type: ImportType,
    filename: string,
    dryRun: boolean,
    totalRows: number,
    preview: PreviewRow[],
    errors: ImportError[],
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
        successRows: dryRun ? tally.ok + tally.update : counts.created + counts.updated,
        errorRows: invalidCount,
        // The reasons only: the rows themselves (client data) are not kept.
        errors: errors.map(({ row, fields }) => ({ row, fields })) as any,
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
        skipCount: tally.skip,
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

  /** The file's rows, header text -> cell text, whether it came as CSV or .xlsx. */
  private async readRows(file: ImportFile): Promise<Record<string, string>[]> {
    if (typeof file === "string") return this.parseCsv(file);
    let rows: Record<string, string>[];
    try {
      rows = await readXlsxRows(file.xlsx);
    } catch (err) {
      if (err instanceof SpreadsheetError) throw new BadRequestException(err.message);
      throw err;
    }
    if (rows.length === 0) throw new BadRequestException("El archivo está vacío");
    return rows;
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
    // Each cell cut as the Excel path cuts them (spreadsheet.ts): a 4 MB
    // "name" used to reach the database.
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        const v = r[k];
        if (typeof v === "string" && v.length > MAX_CELL_CHARS) r[k] = v.slice(0, MAX_CELL_CHARS);
      }
    }
    return rows;
  }
}
