import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { TimeOffKind } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationType } from "../notifications/dto";
import { TimeOffService, TimeOffUser, timeOffView } from "./time-off.service";
import {
  REQUESTABLE_KINDS,
  TimeOffBlock,
  TimeOffInput,
  TimeOffKindName,
  TimeOffStatusName,
  dateOfDay,
  dayOf,
  requestSummary,
  timeOffInputProblem,
} from "./time-off-rules";
import { CreateTimeOffRequestDto, DecideTimeOffDto, TimeOffRequestsQueryDto } from "./dto/time-off.dto";

/** Where the panel lists the requests (the notification's link). */
export const REQUESTS_PAGE = "/dashboard/solicitudes-ausencia";
/** Where a professional follows their own. */
export const MY_TIME_OFF_PAGE = "/dashboard/mis-ausencias";

/** How far back "my absences" reaches: a request answered last month is still worth seeing. */
const MINE_LOOKBACK_DAYS = 60;
/** Enough for any salon's open requests; a list, not an export. */
const LIST_LIMIT = 200;

const PROFESSIONAL = { professional: { select: { firstName: true, lastName: true } } } as const;

const fullName = (p?: { firstName?: string | null; lastName?: string | null } | null) =>
  p ? `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() : "";

/**
 * Time off a professional asks for, and the salon's answer.
 *
 * A professional (staff) asks for time off for themselves only: who it is
 * for comes from the session, never from the body. It is stored pending and
 * blocks nothing until whoever runs the salon (owner, admin) approves it;
 * then it is ordinary time off. A rejected one stays, for the record, and
 * blocks nothing either. Both sides are told in the panel's notifications.
 *
 * Nothing already booked is moved: the request and the approval answer with
 * the appointments that fall inside it, as recording time off does.
 */
@Injectable()
export class TimeOffRequestsService {
  private readonly logger = new Logger(TimeOffRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly timeOff: TimeOffService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The appointments the request would clash with, before it is sent. */
  async preview(user: TimeOffUser, dto: CreateTimeOffRequestDto) {
    const { input } = await this.ownInput(user, dto);
    return { conflicts: await this.timeOff.conflicts(user.tenantId, input) };
  }

  async create(user: TimeOffUser, dto: CreateTimeOffRequestDto) {
    const { input, professionalName } = await this.ownInput(user, dto);
    const row = await this.prisma.timeOff.create({
      data: {
        tenantId: user.tenantId,
        professionalId: input.professionalId!,
        kind: input.kind as TimeOffKind,
        startDate: dateOfDay(input.startDate)!,
        endDate: dateOfDay(input.endDate)!,
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        note: input.note ?? null,
        createdById: user.id,
        requestedById: user.id,
        status: "pending",
      },
      include: PROFESSIONAL,
    });
    const conflicts = await this.timeOff.conflicts(user.tenantId, input);
    await this.tellManagers(user, row, professionalName, conflicts.length);
    return { timeOff: timeOffView(row, "self"), conflicts };
  }

  /** The caller's own time off, requests and what the salon recorded, recent and ahead. */
  async mine(user: TimeOffUser) {
    const own = await this.ownProfessional(user);
    if (!own) return [];
    const since = new Date(Date.now() - MINE_LOOKBACK_DAYS * 86_400_000);
    const rows = await this.prisma.timeOff.findMany({
      where: {
        tenantId: user.tenantId,
        professionalId: own.id,
        endDate: { gte: dateOfDay(dayOf(since))! },
      },
      include: PROFESSIONAL,
      orderBy: [{ startDate: "asc" }, { startTime: "asc" }],
      take: LIST_LIMIT,
    });
    return rows.map((row) => timeOffView(row, "self"));
  }

  /** A request of the caller's own, withdrawn while nobody has answered it. */
  async cancel(user: TimeOffUser, id: string) {
    const { count } = await this.prisma.timeOff.deleteMany({
      where: { id, tenantId: user.tenantId, requestedById: user.id, status: "pending" },
    });
    if (count > 0) return { deleted: true };
    const existing = await this.prisma.timeOff.findFirst({
      where: { id, tenantId: user.tenantId, requestedById: user.id },
      select: { status: true },
    });
    if (!existing) throw new NotFoundException("Solicitud no encontrada");
    throw new ConflictException(
      "Esta solicitud ya está respondida: si necesitas cambiarla, habla con el responsable del salón.",
    );
  }

  /** The salon's requests, the pending ones by default, soonest first. */
  async list(user: TimeOffUser, query: TimeOffRequestsQueryDto) {
    const status: TimeOffStatusName = query.status ?? "pending";
    const rows = await this.prisma.timeOff.findMany({
      where: { tenantId: user.tenantId, requestedById: { not: null }, status },
      include: PROFESSIONAL,
      orderBy:
        status === "pending"
          ? [{ startDate: "asc" }, { startTime: "asc" }]
          : [{ decidedAt: "desc" }, { startDate: "desc" }],
      take: LIST_LIMIT,
    });
    return rows.map((row) => timeOffView(row, "manager"));
  }

  /** How many requests wait for an answer: the menu's badge. */
  async pendingCount(user: TimeOffUser) {
    const count = await this.prisma.timeOff.count({
      where: { tenantId: user.tenantId, requestedById: { not: null }, status: "pending" },
    });
    return { count };
  }

  /**
   * Approves a pending request: from now on it blocks the agenda. Answers
   * with the appointments inside it, for the salon to move or warn.
   */
  async approve(user: TimeOffUser, id: string, dto: DecideTimeOffDto = {}) {
    const row = await this.decide(user, id, "approved", dto.note);
    const conflicts = await this.timeOff.conflicts(user.tenantId, inputOf(row));
    await this.tellRequester(user, row);
    return { timeOff: timeOffView(row, "manager"), conflicts };
  }

  /** Rejects a pending request, with a reason for the requester if given. */
  async reject(user: TimeOffUser, id: string, dto: DecideTimeOffDto = {}) {
    const row = await this.decide(user, id, "rejected", dto.note);
    await this.tellRequester(user, row);
    return { timeOff: timeOffView(row, "manager") };
  }

  /**
   * pending -> approved/rejected, once: the condition on the status makes two
   * managers answering at the same time a 409 for the second, not a flip.
   */
  private async decide(user: TimeOffUser, id: string, status: "approved" | "rejected", note?: string | null) {
    const { count } = await this.prisma.timeOff.updateMany({
      where: { id, tenantId: user.tenantId, status: "pending" },
      data: { status, decidedById: user.id, decidedAt: new Date(), decisionNote: note?.trim() || null },
    });
    const row = await this.prisma.timeOff.findFirst({ where: { id, tenantId: user.tenantId }, include: PROFESSIONAL });
    if (!row) throw new NotFoundException("Solicitud no encontrada");
    if (count === 0) throw new ConflictException("Esta solicitud ya está respondida.");
    return row;
  }

  /**
   * The body as the caller's own absence, checked. A staff account with no
   * professional record has no agenda to ask time off from.
   */
  private async ownInput(
    user: TimeOffUser,
    dto: CreateTimeOffRequestDto,
  ): Promise<{ input: TimeOffInput; professionalName: string }> {
    const own = await this.ownProfessional(user);
    if (!own) {
      throw new ForbiddenException("Tu cuenta no está vinculada a ningún profesional del salón.");
    }
    if (!REQUESTABLE_KINDS.includes(dto.kind as TimeOffKindName)) {
      throw new BadRequestException("Puedes pedir vacaciones, un día libre u otra ausencia.");
    }
    const input: TimeOffInput = {
      // Always the caller's: the body has no say in who it is for.
      professionalId: own.id,
      kind: dto.kind,
      startDate: dto.startDate,
      endDate: dto.endDate,
      startTime: dto.startTime || null,
      endTime: dto.endTime || null,
      note: dto.note || null,
    };
    const problem = timeOffInputProblem(input);
    if (problem) throw new BadRequestException(problem);
    return { input, professionalName: fullName(own) };
  }

  private ownProfessional(user: TimeOffUser) {
    return this.prisma.professional.findFirst({
      where: { userId: user.id, tenantId: user.tenantId },
      select: { id: true, firstName: true, lastName: true },
    });
  }

  /** In the panel of every owner and admin of the salon. Never fails the request. */
  private async tellManagers(user: TimeOffUser, row: any, professionalName: string, clashes: number) {
    try {
      const managers = await this.prisma.user.findMany({
        where: { tenantId: user.tenantId, role: { in: ["owner", "admin"] }, isActive: true },
        select: { id: true },
      });
      const who = professionalName || "Un profesional";
      const clashText =
        clashes === 0 ? "" : clashes === 1 ? " Coincide con 1 cita." : ` Coincide con ${clashes} citas.`;
      // One by one: a manager whose notification fails does not cost the others theirs.
      for (const manager of managers) {
        if (manager.id === user.id) continue;
        await this.notifications
          .create({
            tenantId: user.tenantId,
            userId: manager.id,
            type: NotificationType.SCHEDULE_CHANGE,
            title: "Nueva solicitud de ausencia",
            message: `${who} ha pedido ${requestSummary(row as TimeOffBlock)}.${clashText}`,
            data: { event: "time_off_requested", timeOffId: row.id, link: REQUESTS_PAGE },
          })
          .catch((err: Error) =>
            this.logger.warn(`Could not notify ${manager.id} of time off request ${row.id}: ${err.message}`),
          );
      }
    } catch (err) {
      this.logger.warn(`Could not notify the managers of time off request ${row.id}: ${(err as Error).message}`);
    }
  }

  /** In the requester's panel: approved or rejected, and why. Never fails the answer. */
  private async tellRequester(user: TimeOffUser, row: any) {
    if (!row.requestedById || row.requestedById === user.id) return;
    try {
      const approved = row.status === "approved";
      const reason = row.decisionNote ? ` Motivo: ${row.decisionNote}` : "";
      await this.notifications.create({
        tenantId: user.tenantId,
        userId: row.requestedById,
        type: NotificationType.SCHEDULE_CHANGE,
        title: approved ? "Ausencia aprobada" : "Ausencia rechazada",
        message: approved
          ? `Tu solicitud de ${requestSummary(row as TimeOffBlock)} ha sido aprobada.${row.decisionNote ? ` Nota: ${row.decisionNote}` : ""}`
          : `Tu solicitud de ${requestSummary(row as TimeOffBlock)} ha sido rechazada.${reason}`,
        data: {
          event: approved ? "time_off_approved" : "time_off_rejected",
          timeOffId: row.id,
          link: MY_TIME_OFF_PAGE,
        },
      });
    } catch (err) {
      this.logger.warn(`Could not notify the requester of time off ${row.id}: ${(err as Error).message}`);
    }
  }
}

/** A stored row as the rules read it. */
function inputOf(row: any): TimeOffInput {
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
