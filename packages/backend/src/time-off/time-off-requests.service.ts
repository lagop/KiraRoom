import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { TimeOffKind } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationType } from "../notifications/dto";
import { EmailService } from "../notifications/services/email.service";
import { escapeHtml } from "../common/html-escape";
import { salonDayAndTime } from "../appointments/reschedule-check";
import {
  MY_TIME_OFF_PAGE,
  REQUESTS_PAGE,
  TimeOffService,
  TimeOffUser,
  inputOfRow,
  timeOffView,
} from "./time-off.service";
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

export { MY_TIME_OFF_PAGE, REQUESTS_PAGE };

/** How far back "my absences" reaches: a request answered last month is still worth seeing. */
const MINE_LOOKBACK_DAYS = 60;
/** Enough for any salon's open requests; a list, not an export. */
const LIST_LIMIT = 200;
/** What an unanswered request whose days are gone says when it expires. */
export const EXPIRED_NOTE = "Caducada: no se respondió a tiempo";
/** How many expired requests one run closes at most (the next run takes the rest). */
const EXPIRY_BATCH = 500;

const panelUrl = (path: string) =>
  `${String(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "")}${path}`;

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
 * blocks nothing either. Both sides are told in the panel's notifications,
 * and by email unless the salon turned that off (Tenant.timeOffEmailNotices).
 * A request nobody answered before its last day is closed as rejected
 * ("Caducada") by expireStale, run every hour.
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
    // Optional: specs that do not care about email leave it out.
    @Optional() private readonly email?: EmailService,
  ) {}

  /** Now, replaceable in specs. */
  clock: () => Date = () => new Date();

  /**
   * Pending requests whose last day is already gone, in each salon's own
   * calendar, are closed as rejected with EXPIRED_NOTE, and the professional
   * is told (panel and email). Idempotent: only rows still pending change,
   * so two runs or two instances close nothing twice.
   */
  async expireStale(): Promise<number> {
    const now = this.clock();
    // A day ahead of UTC covers every salon's today (Pacific/Kiritimati is UTC+14).
    const latest = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
    const rows = await this.prisma.timeOff.findMany({
      where: { status: "pending", requestedById: { not: null }, endDate: { lt: dateOfDay(latest)! } },
      include: { ...PROFESSIONAL, tenant: { select: { timezone: true } } },
      orderBy: { endDate: "asc" },
      take: EXPIRY_BATCH,
    });
    let closed = 0;
    for (const row of rows as any[]) {
      const today = salonDayAndTime(now, row.tenant?.timezone || "Europe/Madrid").day;
      if (!(dayOf(row.endDate) < today)) continue;
      const { count } = await this.prisma.timeOff.updateMany({
        where: { id: row.id, tenantId: row.tenantId, status: "pending" },
        data: { status: "rejected", decidedById: null, decidedAt: now, decisionNote: EXPIRED_NOTE },
      });
      if (count === 0) continue;
      closed++;
      await this.tellRequester(
        { id: "", tenantId: row.tenantId, role: "system" },
        { ...row, status: "rejected", decisionNote: EXPIRED_NOTE, decidedAt: now },
        { expired: true },
      );
    }
    return closed;
  }

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
  /**
   * Before approving: the appointments the request clashes with, and a 409
   * when it overlaps the professional's other time off (as approving would).
   */
  async previewApprove(user: TimeOffUser, id: string) {
    const row = await this.prisma.timeOff.findFirst({ where: { id, tenantId: user.tenantId } });
    if (!row) throw new NotFoundException("Solicitud no encontrada");
    if (row.status !== "pending") throw new ConflictException("Esta solicitud ya está respondida.");
    const input = inputOfRow(row);
    await this.timeOff.assertNoOverlap(user.tenantId, input, { excludeId: row.id });
    return { conflicts: await this.timeOff.conflicts(user.tenantId, input) };
  }

  async approve(user: TimeOffUser, id: string, dto: DecideTimeOffDto = {}) {
    // Not on top of time off the professional already has, or another
    // request of theirs for the same days: one of them has to go first.
    const pending = await this.prisma.timeOff.findFirst({ where: { id, tenantId: user.tenantId, status: "pending" } });
    if (pending) await this.timeOff.assertNoOverlap(user.tenantId, inputOfRow(pending), { excludeId: pending.id });
    const row = await this.decide(user, id, "approved", dto.note);
    const conflicts = await this.timeOff.conflicts(user.tenantId, inputOfRow(row));
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
    // Days already gone are not asked for: nobody can be booked on them. The
    // salon's own day, not the server's.
    if (input.endDate < (await this.timeOff.salonToday(user.tenantId))) {
      throw new BadRequestException("No puedes pedir una ausencia para días que ya han pasado.");
    }
    await this.timeOff.assertNoOverlap(user.tenantId, input, { own: true });
    return { input, professionalName: fullName(own) };
  }

  private ownProfessional(user: TimeOffUser) {
    return this.prisma.professional.findFirst({
      where: { userId: user.id, tenantId: user.tenantId },
      select: { id: true, firstName: true, lastName: true },
    });
  }

  /**
   * In the panel of every owner and admin of the salon, and by email unless
   * the salon turned that off. Never fails the request.
   */
  private async tellManagers(user: TimeOffUser, row: any, professionalName: string, clashes: number) {
    try {
      const managers = await this.prisma.user.findMany({
        where: { tenantId: user.tenantId, role: { in: ["owner", "admin"] }, isActive: true },
        select: { id: true, email: true, firstName: true },
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
      if (await this.emailsOn(user.tenantId)) {
        const summary = requestSummary(row as TimeOffBlock);
        for (const manager of managers) {
          if (manager.id === user.id || !manager.email) continue;
          await this.sendEmail(
            manager.email,
            `Nueva solicitud de ausencia de ${who}`,
            `<p>Hola${manager.firstName ? ` ${escapeHtml(manager.firstName)}` : ""},</p>
<p><strong>${escapeHtml(who)}</strong> ha pedido ${escapeHtml(summary)}.${escapeHtml(clashText)}</p>
<p>No bloquea la agenda hasta que la apruebes.</p>
<p><a href="${escapeHtml(panelUrl(REQUESTS_PAGE))}">Aprobar o rechazar la solicitud</a></p>`,
            `time-off-requested-${row.id}-${manager.id}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`Could not notify the managers of time off request ${row.id}: ${(err as Error).message}`);
    }
  }

  /**
   * In the requester's panel, and by email unless the salon turned that off:
   * approved or rejected, and why -- or expired, nobody having answered.
   * Never fails the answer.
   */
  private async tellRequester(user: TimeOffUser, row: any, opts: { expired?: boolean } = {}) {
    if (!row.requestedById || row.requestedById === user.id) return;
    const approved = row.status === "approved";
    const summary = requestSummary(row as TimeOffBlock);
    const title = opts.expired ? "Solicitud caducada" : approved ? "Ausencia aprobada" : "Ausencia rechazada";
    const message = opts.expired
      ? `Tu solicitud de ${summary} ha caducado: nadie la respondió antes de esas fechas.`
      : approved
        ? `Tu solicitud de ${summary} ha sido aprobada.${row.decisionNote ? ` Nota: ${row.decisionNote}` : ""}`
        : `Tu solicitud de ${summary} ha sido rechazada.${row.decisionNote ? ` Motivo: ${row.decisionNote}` : ""}`;
    try {
      await this.notifications.create({
        tenantId: user.tenantId,
        userId: row.requestedById,
        type: NotificationType.SCHEDULE_CHANGE,
        title,
        message,
        data: {
          event: opts.expired ? "time_off_expired" : approved ? "time_off_approved" : "time_off_rejected",
          timeOffId: row.id,
          link: MY_TIME_OFF_PAGE,
        },
      });
    } catch (err) {
      this.logger.warn(`Could not notify the requester of time off ${row.id}: ${(err as Error).message}`);
    }
    try {
      if (!(await this.emailsOn(user.tenantId))) return;
      const requester = await this.prisma.user.findFirst({
        where: { id: row.requestedById, tenantId: user.tenantId, isActive: true },
        select: { email: true, firstName: true },
      });
      if (!requester?.email) return;
      await this.sendEmail(
        requester.email,
        title,
        `<p>Hola${requester.firstName ? ` ${escapeHtml(requester.firstName)}` : ""},</p>
<p>${escapeHtml(message)}</p>
<p><a href="${escapeHtml(panelUrl(MY_TIME_OFF_PAGE))}">Ver mis ausencias</a></p>`,
        `time-off-${opts.expired ? "expired" : row.status}-${row.id}`,
      );
    } catch (err) {
      this.logger.warn(`Could not email the requester of time off ${row.id}: ${(err as Error).message}`);
    }
  }

  /** Whether the salon wants the requests by email too (on unless turned off), and email can be sent. */
  private async emailsOn(tenantId: string): Promise<boolean> {
    if (!this.email?.isConfigured()) return false;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timeOffEmailNotices: true },
    });
    return tenant?.timeOffEmailNotices !== false;
  }

  private async sendEmail(to: string, subject: string, html: string, idempotencyKey: string) {
    const res = await this.email!.sendEmail({ to, subject, html, idempotencyKey }).catch((err: Error) => ({
      success: false,
      error: err.message,
    }));
    if (!res.success) this.logger.warn(`time off email to a user failed: ${(res as any).error ?? "unknown"}`);
  }
}
