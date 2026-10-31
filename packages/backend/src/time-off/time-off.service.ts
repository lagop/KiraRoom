import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { AppointmentStatus, TimeOffKind } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  VISIT_ROW_ORDER,
  VISIT_ROW_SELECT,
  appointmentBusyBlocks,
  clockOf as salonClockOf,
} from "../appointments/visit-totals";
import {
  MAX_QUERY_DAYS,
  TimeOffBlock,
  TimeOffInput,
  blockWindow,
  dateOfDay,
  dayOf,
  daysInRange,
  timeOffInputProblem,
} from "./time-off-rules";
import { CreateTimeOffDto, TimeOffQueryDto, UpdateTimeOffDto } from "./dto/time-off.dto";

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
  constructor(private readonly prisma: PrismaService) {}

  /** The salon's blocks touching `from`..`to`, the salon's closures included. */
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
        ...(query.professionalId ? { professionalId: query.professionalId } : {}),
      },
      include: { professional: { select: { firstName: true, lastName: true } } },
      orderBy: [{ startDate: "asc" }, { startTime: "asc" }],
    });
    const staff = !isManager(user);
    return rows.map((row) => this.view(row, staff));
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
      },
      include: { professional: { select: { firstName: true, lastName: true } } },
    });
    return { timeOff: this.view(row, false), conflicts: await this.conflicts(user.tenantId, input) };
  }

  async update(user: TimeOffUser, id: string, dto: UpdateTimeOffDto) {
    const existing = await this.prisma.timeOff.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!existing) throw new NotFoundException("Ausencia no encontrada");
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
    return { timeOff: this.view(row, false), conflicts: await this.conflicts(user.tenantId, input) };
  }

  /** Hard delete: a removed absence frees its time again, nothing else refers to it. */
  async remove(user: TimeOffUser, id: string) {
    const { count } = await this.prisma.timeOff.deleteMany({ where: { id, tenantId: user.tenantId } });
    if (count === 0) throw new NotFoundException("Ausencia no encontrada");
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
    return input;
  }

  /**
   * A block as the API answers it. Staff see who is away and when, the salon's
   * closures with their note, but not the note on a colleague's absence: why
   * someone is away (a medical appointment) is for whoever runs the salon.
   *
   * Nor do they see that it is sick leave: that a colleague is ill is health
   * data (GDPR art. 9), so to staff it is just an absence ("Ausencia").
   */
  private view(row: any, staff: boolean) {
    const personal = row.professionalId !== null;
    const kind = staff && row.kind === "sick_leave" ? "other" : row.kind;
    return {
      id: row.id,
      professionalId: row.professionalId,
      professionalName: personal ? fullName(row.professional) || null : null,
      kind,
      startDate: dayOf(row.startDate),
      endDate: dayOf(row.endDate),
      startTime: row.startTime ?? null,
      endTime: row.endTime ?? null,
      ...(staff && personal ? {} : { note: row.note ?? null }),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function isManager(user: TimeOffUser): boolean {
  return user.role === "owner" || user.role === "admin";
}
