import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { AppointmentStatus, TimeOffKind } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationType } from "../notifications/dto";
import {
  VISIT_ROW_ORDER,
  VISIT_ROW_SELECT,
  appointmentBusyBlocks,
  clockOf as salonClockOf,
} from "../appointments/visit-totals";
import { salonDayAndTime } from "../appointments/reschedule-check";
import {
  MAX_QUERY_DAYS,
  TimeOffBlock,
  TimeOffInput,
  blockWindow,
  dateOfDay,
  dayOf,
  daysInRange,
  periodLabel,
  requestSummary,
  timeOffInputProblem,
} from "./time-off-rules";
import { CreateTimeOffDto, TimeOffQueryDto, UpdateTimeOffDto } from "./dto/time-off.dto";

/** Where the panel lists the requests (the notification's link). */
export const REQUESTS_PAGE = "/dashboard/solicitudes-ausencia";
/** Where a professional follows their own. */
export const MY_TIME_OFF_PAGE = "/dashboard/mis-ausencias";

/** Enough approved time off ahead for any salon; the clash list reads each one. */
const UPCOMING_LIMIT = 200;

/** Who is calling: the token's user. */
export interface TimeOffUser {
  id: string;
  tenantId: string;
  role: string;
}

/** An appointment that falls inside new time off, for the salon to move or warn. */
export interface TimeOffConflict {
  id: string;
  /** "YYYY-MM-DD", the salon's day. */
  date: string;
  /** "HH:MM", the salon's clock. */
  time: string;
  clientName: string;
  serviceNames: string[];
  /** Whoever of the visit is caught by the block (a closure catches everyone). */
  professionalName: string;
  status: string;
}

/** A clash of approved time off ahead with an appointment still booked. */
export interface UpcomingTimeOffConflict extends TimeOffConflict {
  timeOff: {
    id: string;
    professionalId: string | null;
    professionalName: string | null;
    kind: string;
    startDate: string;
    endDate: string;
    startTime: string | null;
    endTime: string | null;
  };
}

/** Appointments that still hold their time: not cancelled, not done, not missed. */
const LIVE_STATUSES: AppointmentStatus[] = [
  AppointmentStatus.pending,
  AppointmentStatus.confirmed,
  AppointmentStatus.in_progress,
];

/** Enough to list every clash of a long block without reading a salon's whole year. */
const CONFLICT_SCAN_LIMIT = 1000;

const fullName = (p?: { firstName?: string | null; lastName?: string | null } | null) =>
  p ? `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() : "";

/**
 * Time off for professionals and closures of the whole salon.
 *
 * Recording one changes what can be booked from then on (getAvailableSlots,
 * reschedule-check.ts); it never cancels or moves what is already booked.
 * Instead every write -- and the preview before it -- returns the
 * appointments that fall inside it, so the salon can move them or warn the
 * client.
 */
@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);
  /** Now, replaceable in specs. */
  clock: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    // The professional is told when the salon changes or removes time off
    // they asked for. Optional: specs that do not care leave it out.
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** The salon's calendar day now ("YYYY-MM-DD", in its time zone). */
  async salonToday(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    return salonDayAndTime(this.clock(), tenant?.timezone || "Europe/Madrid").day;
  }

  /**
   * The appointments still booked inside approved time off and closures from
   * today on: what the salon has yet to move or warn about. Approving leaves
   * them where they are, so this keeps them in sight after the dialog that
   * listed them is closed. An appointment two blocks catch counts once.
   */
  async upcomingConflicts(user: TimeOffUser): Promise<{ count: number; appointments: UpcomingTimeOffConflict[] }> {
    const today = await this.salonToday(user.tenantId);
    const rows = await this.prisma.timeOff.findMany({
      where: { tenantId: user.tenantId, status: "approved", endDate: { gte: dateOfDay(today)! } },
      include: { professional: { select: { firstName: true, lastName: true } } },
      orderBy: [{ startDate: "asc" }, { startTime: "asc" }],
      take: UPCOMING_LIMIT,
    });
    const seen = new Set<string>();
    const out: UpcomingTimeOffConflict[] = [];
    for (const row of rows) {
      const input = inputOfRow(row);
      // Only what is still ahead: yesterday's clashes are history.
      if (input.startDate < today) input.startDate = today;
      const view = timeOffView(row, "manager");
      for (const conflict of await this.conflicts(user.tenantId, input)) {
        if (seen.has(conflict.id)) continue;
        seen.add(conflict.id);
        out.push({
          ...conflict,
          timeOff: {
            id: view.id,
            professionalId: view.professionalId,
            professionalName: view.professionalName,
            kind: view.kind,
            startDate: view.startDate,
            endDate: view.endDate,
            startTime: view.startTime,
            endTime: view.endTime,
          },
        });
      }
    }
    out.sort((a, b) => (a.date === b.date ? a.time.localeCompare(b.time) : a.date.localeCompare(b.date)));
    return { count: out.length, appointments: out };
  }

  /**
   * A professional's approved or pending time off that overlaps `input` (the
   * same days, and the same hours when both are a few hours of one day):
   * recording it twice would leave two rows, and removing one would keep the
   * other blocking without anyone seeing why. A 409 that names the other.
   * Closures are not checked: they are the salon's, not anyone's.
   */
  async assertNoOverlap(
    tenantId: string,
    input: TimeOffInput,
    opts: { excludeId?: string; own?: boolean } = {},
  ): Promise<void> {
    if (!input.professionalId) return;
    const rows = await this.prisma.timeOff.findMany({
      where: {
        tenantId,
        professionalId: input.professionalId,
        status: { in: ["approved", "pending"] },
        startDate: { lte: dateOfDay(input.endDate)! },
        endDate: { gte: dateOfDay(input.startDate)! },
        ...(opts.excludeId ? { id: { not: opts.excludeId } } : {}),
      },
      include: { professional: { select: { firstName: true, lastName: true } } },
      orderBy: [{ startDate: "asc" }, { startTime: "asc" }],
    });
    const mine = blockWindow(input as TimeOffBlock);
    const clash = rows.find((row) => {
      const theirs = blockWindow(row as TimeOffBlock);
      return theirs.startMinutes < mine.endMinutes && mine.startMinutes < theirs.endMinutes;
    });
    if (!clash) return;
    const period = periodLabel(clash as TimeOffBlock);
    const who = fullName(clash.professional) || "Este profesional";
    if (clash.status === "pending") {
      throw new ConflictException(
        opts.own
          ? `Ya tienes una solicitud pendiente ${period} que coincide con estas fechas.`
          : `${who} ya tiene una solicitud pendiente ${period} que coincide con estas fechas: apruébala o recházala en Solicitudes de ausencia.`,
      );
    }
    throw new ConflictException(
      opts.own
        ? `Ya tienes una ausencia aprobada ${period} que coincide con estas fechas.`
        : `${who} ya tiene una ausencia aprobada ${period} que coincide con estas fechas: cámbiala en lugar de registrar otra.`,
    );
  }

  /**
   * The salon's blocks touching `from`..`to`, the salon's closures included:
   * approved ones only, what blocks the agenda. Whoever runs the salon may
   * ask for the pending requests too (the calendar marks them).
   */
  async list(user: TimeOffUser, query: TimeOffQueryDto) {
    if (query.to < query.from) throw new BadRequestException("La fecha final no puede ser anterior a la inicial.");
    const days = daysInRange(query.from, query.to);
    if (!(days <= MAX_QUERY_DAYS)) {
      throw new BadRequestException(`Se pueden consultar como máximo ${MAX_QUERY_DAYS} días a la vez.`);
    }
    const rows = await this.prisma.timeOff.findMany({
      where: {
        tenantId: user.tenantId,
        startDate: { lte: dateOfDay(query.to)! },
        endDate: { gte: dateOfDay(query.from)! },
        status: isManager(user) && query.includePending ? { in: ["approved", "pending"] } : "approved",
        ...(query.professionalId ? { professionalId: query.professionalId } : {}),
      },
      include: { professional: { select: { firstName: true, lastName: true } } },
      orderBy: [{ startDate: "asc" }, { startTime: "asc" }],
    });
    const audience: TimeOffAudience = isManager(user) ? "manager" : "colleague";
    return rows.map((row) => timeOffView(row, audience));
  }

  /** The appointments a block would clash with, before it is saved. */
  async preview(user: TimeOffUser, dto: CreateTimeOffDto) {
    const input = await this.validInput(user, dto);
    return { conflicts: await this.conflicts(user.tenantId, input) };
  }

  async create(user: TimeOffUser, dto: CreateTimeOffDto) {
    const input = await this.validInput(user, dto);
    const row = await this.prisma.timeOff.create({
      data: {
        tenantId: user.tenantId,
        professionalId: input.professionalId ?? null,
        kind: input.kind as TimeOffKind,
        startDate: dateOfDay(input.startDate)!,
        endDate: dateOfDay(input.endDate)!,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        note: input.note ?? null,
        createdById: user.id,
        // What the salon records is decided already.
        status: "approved",
      },
      include: { professional: { select: { firstName: true, lastName: true } } },
    });
    return { timeOff: timeOffView(row, "manager"), conflicts: await this.conflicts(user.tenantId, input) };
  }

  async update(user: TimeOffUser, id: string, dto: UpdateTimeOffDto) {
    const existing = await this.prisma.timeOff.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!existing) throw new NotFoundException("Ausencia no encontrada");
    const before = inputOfRow(existing);
    // A field left out keeps its value; null clears the hours (all day).
    const pick = <K extends keyof UpdateTimeOffDto>(key: K, current: unknown) =>
      dto[key] !== undefined ? dto[key] : current;
    const input: TimeOffInput = {
      professionalId: existing.professionalId,
      kind: pick("kind", existing.kind) as string,
      startDate: pick("startDate", dayOf(existing.startDate)) as string,
      endDate: pick("endDate", dayOf(existing.endDate)) as string,
      startTime: pick("startTime", existing.startTime) as string | null,
      endTime: pick("endTime", existing.endTime) as string | null,
      note: pick("note", existing.note) as string | null,
    };
    const problem = timeOffInputProblem(input);
    if (problem) throw new BadRequestException(problem);
    // A rejected request blocks nothing, so it cannot double anything up.
    if (existing.status !== "rejected") {
      await this.assertNoOverlap(user.tenantId, input, { excludeId: existing.id });
    }
    const row = await this.prisma.timeOff.update({
      where: { id: existing.id, tenantId: user.tenantId },
      data: {
        kind: input.kind as TimeOffKind,
        startDate: dateOfDay(input.startDate)!,
        endDate: dateOfDay(input.endDate)!,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        note: input.note ?? null,
      },
      include: { professional: { select: { firstName: true, lastName: true } } },
    });
    const moved = (["kind", "startDate", "endDate", "startTime", "endTime"] as const).some(
      (key) => (before[key] ?? null) !== (input[key] ?? null),
    );
    if (moved) await this.tellRequester(user, row, "time_off_changed", before as TimeOffBlock);
    return { timeOff: timeOffView(row, "manager"), conflicts: await this.conflicts(user.tenantId, input) };
  }

  /**
   * Hard delete: a removed absence frees its time again, nothing else refers
   * to it. Not a request still waiting for an answer: that one is rejected,
   * so the professional gets one.
   */
  async remove(user: TimeOffUser, id: string) {
    const existing = await this.prisma.timeOff.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!existing) throw new NotFoundException("Ausencia no encontrada");
    if (existing.status === "pending") {
      throw new ConflictException("Esta solicitud está pendiente: recházala para que quede respuesta.");
    }
    // Never a pending request, whatever was read.
    const { count } = await this.prisma.timeOff.deleteMany({
      where: { id, tenantId: user.tenantId, status: { not: "pending" } },
    });
    if (count === 0) throw new NotFoundException("Ausencia no encontrada");
    // A rejected request blocked nothing: removing it changes nothing for them.
    if (existing.status !== "rejected") await this.tellRequester(user, existing, "time_off_deleted");
    return { deleted: true };
  }

  /**
   * The salon's live appointments the block overlaps: for a professional's
   * time off, the visits they work in -- their own, and their services in a
   * colleague's visit, each service row on its own professional
   * (visit-totals.ts) -- and for a closure, every visit those days.
   */
  async conflicts(tenantId: string, block: TimeOffInput): Promise<TimeOffConflict[]> {
    const professionalId = block.professionalId ?? null;
    const [tenant, appointments] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      (this.prisma.appointment.findMany as any)({
        where: {
          tenantId,
          scheduledDate: {
            gte: new Date(`${block.startDate}T00:00:00.000Z`),
            lte: new Date(`${block.endDate}T23:59:59.999Z`),
          },
          status: { in: LIVE_STATUSES },
          ...(professionalId
            ? { OR: [{ professionalId }, { services: { some: { professionalId } } }] }
            : {}),
        },
        select: {
          id: true,
          professionalId: true,
          scheduledDate: true,
          scheduledTime: true,
          duration: true,
          status: true,
          client: { select: { firstName: true, lastName: true } },
          service: { select: { name: true } },
          professional: { select: { id: true, firstName: true, lastName: true } },
          services: {
            select: {
              ...VISIT_ROW_SELECT,
              service: { select: { duration: true, price: true, name: true } },
              professional: { select: { id: true, firstName: true, lastName: true } },
            },
            orderBy: VISIT_ROW_ORDER,
          },
        },
        orderBy: [{ scheduledDate: "asc" }, { scheduledTime: "asc" }],
        take: CONFLICT_SCAN_LIMIT,
      }) as Promise<any[]>,
    ]);
    const timeZone = tenant?.timezone || "Europe/Madrid";
    const window = blockWindow(block as TimeOffBlock);

    const out: TimeOffConflict[] = [];
    for (const apt of appointments) {
      const day = dayOf(apt.scheduledDate);
      const caught = appointmentBusyBlocks(apt, timeZone, day).filter(
        (b) =>
          !b.cleanup &&
          (professionalId === null || b.professionalId === professionalId) &&
          b.startMinutes < window.endMinutes &&
          window.startMinutes < b.endMinutes,
      );
      if (caught.length === 0) continue;

      const names = new Map<string, string>();
      if (apt.professional) names.set(apt.professional.id ?? apt.professionalId, fullName(apt.professional));
      for (const row of apt.services ?? []) {
        if (row.professional) names.set(row.professional.id ?? row.professionalId, fullName(row.professional));
      }
      const live = (apt.services ?? []).filter((r: any) => r.status !== "cancelled");
      const serviceNames: string[] = live.length
        ? live.map((r: any) => r.service?.name).filter(Boolean)
        : [apt.service?.name].filter(Boolean);
      out.push({
        id: apt.id,
        date: day,
        time: salonClockOf(apt.scheduledTime ?? "", timeZone) ?? String(apt.scheduledTime ?? ""),
        clientName: fullName(apt.client) || "Cliente",
        serviceNames,
        professionalName: [...new Set(caught.map((b) => names.get(b.professionalId) ?? ""))]
          .filter(Boolean)
          .join(", "),
        status: apt.status,
      });
    }
    return out;
  }

  /** The body as a block, checked: rules between fields, and a professional of this salon. */
  private async validInput(user: TimeOffUser, dto: CreateTimeOffDto): Promise<TimeOffInput> {
    const input: TimeOffInput = {
      professionalId: dto.professionalId || null,
      kind: dto.kind,
      startDate: dto.startDate,
      endDate: dto.endDate,
      startTime: dto.startTime || null,
      endTime: dto.endTime || null,
      note: dto.note || null,
    };
    const problem = timeOffInputProblem(input);
    if (problem) throw new BadRequestException(problem);
    if (input.professionalId) {
      const professional = await this.prisma.professional.findFirst({
        where: { id: input.professionalId, tenantId: user.tenantId },
        select: { id: true },
      });
      if (!professional) throw new NotFoundException("Profesional no encontrado en este salón");
    }
    await this.assertNoOverlap(user.tenantId, input);
    return input;
  }

  /**
   * In the panel of the professional who asked for this time off, when
   * whoever runs the salon changes or removes it: their agenda opens (or
   * shifts) without them knowing otherwise. Not for one's own changes, nor
   * for time off the salon recorded itself. Never fails the change.
   */
  private async tellRequester(
    user: TimeOffUser,
    row: any,
    event: "time_off_changed" | "time_off_deleted",
    before?: TimeOffBlock,
  ) {
    if (!this.notifications || !row.requestedById || row.requestedById === user.id) return;
    try {
      await this.notifications.create({
        tenantId: user.tenantId,
        userId: row.requestedById,
        type: NotificationType.SCHEDULE_CHANGE,
        title: event === "time_off_deleted" ? "Ausencia eliminada" : "Ausencia modificada",
        message:
          event === "time_off_deleted"
            ? `El responsable del salón ha eliminado tu ausencia (${requestSummary(row as TimeOffBlock)}). Ese tiempo vuelve a estar disponible para citas.`
            : `El responsable del salón ha cambiado tu ausencia: antes ${requestSummary(before as TimeOffBlock)}, ahora ${requestSummary(row as TimeOffBlock)}.`,
        data: { event, timeOffId: row.id, link: MY_TIME_OFF_PAGE },
      });
    } catch (err) {
      this.logger.warn(`Could not tell the requester of time off ${row.id}: ${(err as Error).message}`);
    }
  }
}

/** A stored row as the rules read it. */
export function inputOfRow(row: any): TimeOffInput {
  return {
    professionalId: row.professionalId,
    kind: row.kind,
    startDate: dayOf(row.startDate),
    endDate: dayOf(row.endDate),
    startTime: row.startTime ?? null,
    endTime: row.endTime ?? null,
    note: row.note ?? null,
  };
}

/**
 * Who reads a block: whoever runs the salon, the professional it is about
 * (their own requests and absences), or a colleague (the calendar).
 */
export type TimeOffAudience = "manager" | "self" | "colleague";

/**
 * A block as the API answers it. Staff see who is away and when, the salon's
 * closures with their note, but not the note on a colleague's absence: why
 * someone is away (a medical appointment) is for whoever runs the salon.
 *
 * Nor do they see that it is sick leave: that a colleague is ill is health
 * data (GDPR art. 9), so to staff it is just an absence ("Ausencia"). Their
 * own absences they see as they are, notes and the answer to a request
 * included.
 */
export function timeOffView(row: any, audience: TimeOffAudience) {
  const personal = row.professionalId !== null;
  const colleague = audience === "colleague";
  const kind = colleague && row.kind === "sick_leave" ? "other" : row.kind;
  return {
    id: row.id,
    professionalId: row.professionalId,
    professionalName: personal ? fullName(row.professional) || null : null,
    kind,
    status: row.status ?? "approved",
    startDate: dayOf(row.startDate),
    endDate: dayOf(row.endDate),
    startTime: row.startTime ?? null,
    endTime: row.endTime ?? null,
    ...(colleague && personal ? {} : { note: row.note ?? null }),
    ...(colleague
      ? {}
      : {
          requested: !!row.requestedById,
          decidedAt: row.decidedAt ?? null,
          decisionNote: row.decisionNote ?? null,
        }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function isManager(user: TimeOffUser): boolean {
  return user.role === "owner" || user.role === "admin";
}
