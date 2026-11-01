import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditLogService } from '../saas/audit-log.service';
import { SALON_MANAGERS } from '../auth/decorators/roles.decorator';
import { safeTimeZone } from '../gift-cards/gift-card-expiry';
import { salonInstant } from '../appointments/salon-time';
import { addDays } from '../analytics/analytics-metrics';
import { openCashSessionId } from './cash-session-lock';
import { checkedBreakdown, discrepancyCents, sessionFigures, type SessionFigures } from './cash-session-math';
import type { CashMovementDto, CashSessionListQueryDto, CloseCashSessionDto, OpenCashSessionDto } from './dto/cash-session.dto';

export interface CashActor {
  id: string;
  role: string;
}

/** A session as the owner and managers see it: figures, expected cash, difference. */
export type CashSessionFullView = Awaited<ReturnType<CashSessionsService['fullView']>>;
/** A session as staff see it: no expected cash, no totals, no difference (blind count). */
export type CashSessionBlindView = Awaited<ReturnType<CashSessionsService['blindView']>>;

/** Prisma, or the transaction a write runs in. */
type Db = any;

const notOpen = () =>
  new ConflictException({
    code: 'CASH_SESSION_NOT_OPEN',
    message: 'Esta caja ya está cerrada. Recarga la página para ver la caja actual.',
  });

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'P2002';
}

function euros(cents: number): string {
  return (cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

/**
 * The cash drawer at the till: opening it with a float, money put in or
 * taken out, closing it with the cash counted (arqueo), and its reports.
 *
 * - One session open per salon at a time (the till has no location): the
 *   database refuses a second one (partial unique index), so two "Abrir
 *   caja" at once give one session and a 409.
 * - While a session is open, every sale at the till, its payments and
 *   every refund are linked to it (PosService.processCheckout,
 *   PaymentsService.refundPayment), holding the session row FOR SHARE.
 *   Closing takes it FOR UPDATE, so the money of a sale being written is
 *   in the count, or the sale comes after the close and finds no drawer.
 * - Cash taken at the till needs an open session; card, Bizum and the rest
 *   do not (cash-session-lock.ts).
 *
 * Who: anyone on the team opens, moves money and closes (they run the
 * till); the history and other people's past sessions are the owner's and
 * managers'.
 *
 * Blind count (arqueo ciego): staff see only their own sales, so the drawer
 * shows them no salon-wide figure. Every session a staff member is shown
 * (current, open, close, report) is the blind view (blindView): who opened
 * it and when, the float, the movements they made, and, once closed, what
 * they counted. No expected cash, no totals by method, no difference: the
 * server still works them out and stores them at close, for the owner and
 * managers, who get the full view (fullView).
 */
@Injectable()
export class CashSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private isManager(actor: CashActor): boolean {
    return (SALON_MANAGERS as string[]).includes(actor.role);
  }

  private async audit(tx: Db, action: string, tenantId: string, actor: CashActor, metadata: Record<string, unknown>) {
    await this.auditLog.record(action, { actorId: actor.id, actorRole: actor.role as UserRole, tenantId, metadata }, tx);
  }

  /** `GET /pos/cash-sessions/current`: the open session with its figures, or the last closing count. */
  async current(tenantId: string, actor: CashActor) {
    const session = await this.prisma.cashSession.findFirst({ where: { tenantId, status: 'open' } });
    const lastClosed = session
      ? null
      : await this.prisma.cashSession.findFirst({
          where: { tenantId, status: 'closed' },
          orderBy: { closedAt: 'desc' },
          select: { id: true, closedAt: true, countedCashCents: true },
        });
    return {
      session: session ? await this.view(this.prisma, tenantId, session, actor) : null,
      /** What was left in the drawer last time: the panel offers it as the new float. */
      lastClosed,
      canSeeHistory: this.isManager(actor),
    };
  }

  /** `POST /pos/cash-sessions/open`. */
  async open(tenantId: string, actor: CashActor, dto: OpenCashSessionDto) {
    try {
      const session = await this.prisma.$transaction(async (tx: Db) => {
        const created = await tx.cashSession.create({
          data: {
            tenantId,
            openedById: actor.id,
            openingFloatCents: dto.openingFloatCents,
            openingNotes: dto.notes?.trim() || null,
          },
        });
        await this.audit(tx, 'pos.cash_session.opened', tenantId, actor, {
          sessionId: created.id,
          openingFloatCents: dto.openingFloatCents,
        });
        return created;
      });
      return this.view(this.prisma, tenantId, session, actor);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          code: 'CASH_SESSION_ALREADY_OPEN',
          message: 'Ya hay una caja abierta. Recarga la página para verla.',
        });
      }
      throw err;
    }
  }

  /** `POST /pos/cash-sessions/:id/movements`: money put in or taken out, with why. */
  async addMovement(tenantId: string, sessionId: string, actor: CashActor, dto: CashMovementDto) {
    const reason = dto.reason?.trim();
    if (!reason) throw new BadRequestException('Indica el motivo.');
    return this.prisma.$transaction(async (tx: Db) => {
      // Held until this commits: the session cannot close under it.
      const openId = await openCashSessionId(tx, tenantId, 'share');
      if (openId !== sessionId) throw notOpen();
      // The cap says what the drawer should hold: only to those who may know
      // it. A blind count cannot refuse on it either, or trying amounts
      // would tell staff the expected cash; their movement is recorded with
      // their name and a wrong one shows as a difference at close.
      if (dto.type === 'out' && this.isManager(actor)) {
        const session = await tx.cashSession.findFirst({ where: { id: sessionId, tenantId } });
        const figures = await this.figuresOf(tx, tenantId, session);
        if (dto.amountCents > figures.cash.expectedCents) {
          throw new BadRequestException(
            `En la caja debería haber ${euros(Math.max(0, figures.cash.expectedCents))}: no se puede sacar más.`,
          );
        }
      }
      const movement = await tx.cashMovement.create({
        data: { tenantId, sessionId, type: dto.type, amountCents: dto.amountCents, reason, createdById: actor.id },
      });
      await this.audit(tx, 'pos.cash_movement.created', tenantId, actor, {
        sessionId,
        movementId: movement.id,
        type: dto.type,
        amountCents: dto.amountCents,
        reason,
      });
      return movement;
    });
  }

  /**
   * `POST /pos/cash-sessions/:id/close`: the cash counted. The expected cash
   * is worked out with the session locked (no sale or refund can join it
   * meanwhile) and stored with the difference.
   */
  async close(tenantId: string, sessionId: string, actor: CashActor, dto: CloseCashSessionDto) {
    let breakdown: Record<string, number> | null;
    try {
      breakdown = checkedBreakdown(dto.breakdown, dto.countedCashCents);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const closed = await this.prisma.$transaction(
      async (tx: Db) => {
        const openId = await openCashSessionId(tx, tenantId, 'update');
        if (openId !== sessionId) {
          const exists = await tx.cashSession.findFirst({ where: { id: sessionId, tenantId }, select: { id: true } });
          if (!exists) throw new NotFoundException('Caja no encontrada');
          throw notOpen();
        }
        const session = await tx.cashSession.findFirst({ where: { id: sessionId, tenantId } });
        const figures = await this.figuresOf(tx, tenantId, session);
        const expected = figures.cash.expectedCents;
        const discrepancy = discrepancyCents(dto.countedCashCents, expected);
        const updated = await tx.cashSession.update({
          where: { id: sessionId },
          data: {
            status: 'closed',
            closedById: actor.id,
            closedAt: new Date(),
            countedCashCents: dto.countedCashCents,
            expectedCashCents: expected,
            discrepancyCents: discrepancy,
            closingNotes: dto.notes?.trim() || null,
            ...(breakdown ? { countBreakdown: breakdown } : {}),
          },
        });
        await this.audit(tx, 'pos.cash_session.closed', tenantId, actor, {
          sessionId,
          countedCashCents: dto.countedCashCents,
          expectedCashCents: expected,
          discrepancyCents: discrepancy,
        });
        return updated;
      },
      { timeout: 20_000 },
    );
    return this.view(this.prisma, tenantId, closed, actor);
  }

  /** `GET /pos/cash-sessions`: past sessions, newest first, with their differences (owner and managers). */
  async list(tenantId: string, query: CashSessionListQueryDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    const tz = safeTimeZone(tenant?.timezone);
    const openedAt: Record<string, Date> = {};
    if (query.from) openedAt.gte = salonInstant(query.from, '00:00', tz);
    if (query.to) openedAt.lt = salonInstant(addDays(query.to, 1), '00:00', tz);
    const where = { tenantId, ...(Object.keys(openedAt).length ? { openedAt } : {}) };
    const page = query.page ?? 1;
    const limit = query.limit ?? 30;
    const [rows, total, sums] = await Promise.all([
      this.prisma.cashSession.findMany({ where, orderBy: { openedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.cashSession.count({ where }),
      this.prisma.cashSession.aggregate({
        where: { ...where, status: 'closed' },
        _sum: { countedCashCents: true, expectedCashCents: true, discrepancyCents: true },
        _count: { _all: true },
      }),
    ]);
    const names = await this.namesOf(rows.flatMap((r: any) => [r.openedById, r.closedById]));
    return {
      sessions: rows.map((r: any) => ({ ...this.summaryOf(r), openedBy: names.of(r.openedById), closedBy: names.of(r.closedById) })),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      totals: {
        closedSessions: sums._count?._all ?? 0,
        countedCashCents: sums._sum?.countedCashCents ?? 0,
        expectedCashCents: sums._sum?.expectedCashCents ?? 0,
        discrepancyCents: sums._sum?.discrepancyCents ?? 0,
      },
    };
  }

  /**
   * `GET /pos/cash-sessions/:id`: a session's report. The owner and
   * managers see any; the rest of the team the open one (they count it) and
   * the ones they opened or closed.
   */
  async report(tenantId: string, sessionId: string, actor: CashActor) {
    const session = await this.prisma.cashSession.findFirst({ where: { id: sessionId, tenantId } });
    if (!session) throw new NotFoundException('Caja no encontrada');
    const own = session.openedById === actor.id || session.closedById === actor.id;
    if (!this.isManager(actor) && session.status !== 'open' && !own) {
      throw new ForbiddenException('Solo puedes ver las cajas que has abierto o cerrado tú.');
    }
    return this.view(this.prisma, tenantId, session, actor);
  }

  // ------------------------------------------------------------------ helpers

  /** The session's figures from the rows linked to it (cash-session-math.ts). */
  async figuresOf(db: Db, tenantId: string, session: any): Promise<SessionFigures> {
    const sessionId = session.id as string;
    const payments = await db.payment.findMany({
      where: { tenantId, cashSessionId: sessionId, status: { in: ['paid', 'refunded'] } },
      select: { method: true, amount: true },
    });
    const refunds = await db.refund.findMany({
      where: { cashSessionId: sessionId, status: 'succeeded', payment: { tenantId } },
      select: { amount: true, payment: { select: { method: true } } },
    });
    const sales = await db.posSale.findMany({
      where: { tenantId, cashSessionId: sessionId },
      select: { totalCents: true, subtotalCents: true, discountCents: true, loyaltyDiscountCents: true, changeCents: true },
    });
    const tax = await db.posSaleLine.aggregate({
      where: { tenantId, sale: { cashSessionId: sessionId } },
      _sum: { taxCents: true },
    });
    const movements = await db.cashMovement.findMany({
      where: { tenantId, sessionId },
      select: { type: true, amountCents: true },
    });
    // Wallet top-ups taken while it was open (WalletService.topUp): only
    // those with a tender; a refund back to the wallet moves no money here.
    const topUps = await db.walletTransaction.findMany({
      where: { cashSessionId: sessionId, type: 'credit', method: { not: null }, wallet: { tenantId } },
      select: { method: true, amount: true },
    });
    return sessionFigures({
      openingFloatCents: session.openingFloatCents,
      payments: payments.map((p: any) => ({ method: String(p.method), amount: p.amount })),
      refunds: refunds.map((r: any) => ({ method: String(r.payment?.method ?? ''), amount: r.amount })),
      sales,
      taxCents: tax?._sum?.taxCents ?? 0,
      movements: movements.map((m: any) => ({ type: m.type, amountCents: m.amountCents })),
      walletTopUps: topUps.map((t: any) => ({ method: String(t.method), amount: t.amount })),
    });
  }

  private summaryOf(s: any) {
    return {
      id: s.id,
      status: s.status as 'open' | 'closed',
      openedAt: s.openedAt,
      openingFloatCents: s.openingFloatCents,
      closedAt: s.closedAt ?? null,
      countedCashCents: s.countedCashCents ?? null,
      expectedCashCents: s.expectedCashCents ?? null,
      discrepancyCents: s.discrepancyCents ?? null,
    };
  }

  /** Team members' names by id (they may have left: then null). */
  private async namesOf(ids: Array<string | null | undefined>) {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    const users = unique.length
      ? await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const byId = new Map<string, string>(users.map((u: any) => [u.id, `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()]));
    return { of: (id?: string | null) => (id ? { id, name: byId.get(id) || null } : null) };
  }

  /** A session as the panel shows it and prints it: in full to the owner and managers, blind to the rest. */
  private async view(db: Db, tenantId: string, session: any, actor: CashActor) {
    return this.isManager(actor) ? this.fullView(db, tenantId, session) : this.blindView(db, tenantId, session, actor);
  }

  private async movementsOf(db: Db, tenantId: string, sessionId: string, createdById?: string) {
    return db.cashMovement.findMany({
      where: { tenantId, sessionId, ...(createdById ? { createdById } : {}) },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, type: true, amountCents: true, reason: true, createdById: true },
    });
  }

  private async salonOf(db: Db, tenantId: string) {
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, timezone: true } });
    return { name: tenant?.name ?? '', timezone: safeTimeZone(tenant?.timezone) };
  }

  private movementView(m: any, names: { of: (id?: string | null) => { id: string; name: string | null } | null }) {
    return {
      id: m.id,
      createdAt: m.createdAt,
      type: m.type,
      amountCents: m.amountCents,
      reason: m.reason,
      createdBy: names.of(m.createdById),
    };
  }

  /** The owner's and managers' view: the figures, what the drawer should hold, the difference. */
  async fullView(db: Db, tenantId: string, session: any) {
    const figures = await this.figuresOf(db, tenantId, session);
    const movements = await this.movementsOf(db, tenantId, session.id);
    const names = await this.namesOf([session.openedById, session.closedById, ...movements.map((m: any) => m.createdById)]);
    const closed = session.status === 'closed';
    return {
      blind: false as const,
      ...this.summaryOf(session),
      openedBy: names.of(session.openedById),
      closedBy: names.of(session.closedById),
      openingNotes: session.openingNotes ?? null,
      closingNotes: session.closingNotes ?? null,
      countBreakdown: session.countBreakdown ?? null,
      // Open: what the drawer should hold now. Closed: what was stored at close.
      expectedCashCents: closed ? session.expectedCashCents : figures.cash.expectedCents,
      figures,
      movements: movements.map((m: any) => this.movementView(m, names)),
      salon: await this.salonOf(db, tenantId),
    };
  }

  /**
   * The blind view (staff): what they can see at the drawer without being
   * told what it should hold. Who opened it and when, the float (counted
   * in), their own movements, and once closed, who closed it, when, and
   * what was counted. Built from these fields only, so a figure added to
   * the full view does not reach staff by accident; nothing is worked out.
   */
  async blindView(db: Db, tenantId: string, session: any, actor: CashActor) {
    const movements = await this.movementsOf(db, tenantId, session.id, actor.id);
    const names = await this.namesOf([session.openedById, session.closedById, actor.id]);
    const closed = session.status === 'closed';
    return {
      blind: true as const,
      id: session.id as string,
      status: session.status as 'open' | 'closed',
      openedAt: session.openedAt,
      openingFloatCents: session.openingFloatCents,
      openedBy: names.of(session.openedById),
      openingNotes: session.openingNotes ?? null,
      closedAt: closed ? (session.closedAt ?? null) : null,
      closedBy: closed ? names.of(session.closedById) : null,
      countedCashCents: closed ? (session.countedCashCents ?? null) : null,
      countBreakdown: closed ? (session.countBreakdown ?? null) : null,
      closingNotes: closed ? (session.closingNotes ?? null) : null,
      movements: movements.map((m: any) => this.movementView(m, names)),
      salon: await this.salonOf(db, tenantId),
    };
  }
}
