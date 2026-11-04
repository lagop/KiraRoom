import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { EmailService } from '../../notifications/services/email.service';
import { AuditLogService } from '../../saas/audit-log.service';
import { escapeHtml } from '../../common/html-escape';

/**
 * The receptionist's conversations in the panel (Conversaciones): read-only,
 * every channel, always the caller's salon. From here the salon pauses the
 * assistant in one conversation (it stores the client's messages but does
 * not answer, on every channel) and marks the ones it was told about as
 * attended. Replying from the panel is not part of it.
 *
 * The salon is told (panel notification + email to the owner and admins)
 * when a client asks for a person or the assistant cannot answer: once per
 * conversation until someone marks it attended.
 */

export type AttentionReason = 'client_asked_person' | 'assistant_could_not_answer';

export const INBOX_PAGE = '/dashboard/conversaciones';
export const INBOX_PAGE_SIZE = 30;

export type InboxView = 'all' | 'attention' | 'paused';

export interface InboxFilters {
  view?: InboxView;
  channel?: string;
  /** Text in a message, or the client's name. */
  q?: string;
  page?: number;
}

export interface InboxActor {
  id: string;
  role: UserRole;
  tenantId: string;
}

const CHANNELS = ['web', 'whatsapp', 'facebook', 'instagram', 'telegram'] as const;

/**
 * Someone asking, in the client's own words, to talk to a person. The model
 * also calls request_salon_attention; this catches what it misses.
 */
const ASKS_FOR_PERSON =
  /\b(hablar|habla|hable|contactar|comunicarme|ponerme en contacto|pasarme|pásame|pasame|atender|atienda)\b.{0,40}\b(persona|humano|humana|alguien|encargad[ao]|responsable|dueñ[ao]|recepcionista real|equipo|peluquer[ao]|esteticista)\b|\b(talk|speak)\b.{0,30}\b(person|human|someone|manager|owner|staff)\b|\b(no eres|eres) (un |una )?(robot|bot|máquina|maquina)\b/i;

export function asksForPerson(message: string): boolean {
  return ASKS_FOR_PERSON.test(message ?? '');
}

const panelUrl = (path: string) =>
  `${String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}${path}`;

const REASON_TEXT: Record<AttentionReason, string> = {
  client_asked_person: 'ha pedido hablar con alguien del salón',
  assistant_could_not_answer: 'tiene una pregunta que el asistente no ha sabido responder',
};

const CHANNEL_TEXT: Record<string, string> = {
  web: 'el chat de tu web',
  whatsapp: 'WhatsApp',
  facebook: 'Messenger',
  instagram: 'Instagram',
  telegram: 'Telegram',
};

/** Who wrote, for the list: her client file's name, the name she booked with, or her channel id. */
function displayName(row: {
  channel: string;
  client?: { firstName: string | null; lastName: string | null } | null;
  context: unknown;
}): string {
  const fromClient = [row.client?.firstName, row.client?.lastName].filter(Boolean).join(' ').trim();
  if (fromClient) return fromClient;
  const ctx = (row.context ?? {}) as Record<string, any>;
  const pending = ctx.pendingBooking ?? {};
  const proposed = [pending.firstName, pending.lastName].filter(Boolean).join(' ').trim();
  if (proposed) return proposed;
  if (typeof ctx.clientName === 'string' && ctx.clientName.trim()) return ctx.clientName.trim();
  const key = typeof ctx.visitorKey === 'string' ? ctx.visitorKey : '';
  if (key.startsWith('whatsapp-')) return `+${key.slice('whatsapp-'.length)}`;
  return '';
}

@Injectable()
export class ReceptionistInboxService {
  private readonly logger = new Logger(ReceptionistInboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly email?: EmailService,
  ) {}

  async list(tenantId: string, filters: InboxFilters = {}) {
    const page = Math.max(1, Math.floor(filters.page ?? 1));
    const where: Prisma.ChatConversationWhereInput = { tenantId, totalMessages: { gt: 0 } };
    if (filters.view === 'attention') where.attentionAt = { not: null };
    if (filters.view === 'paused') where.assistantPausedAt = { not: null };
    if (filters.channel && (CHANNELS as readonly string[]).includes(filters.channel)) {
      where.channel = filters.channel as any;
    }
    const q = filters.q?.trim().slice(0, 100);
    if (q) {
      where.OR = [
        { messages: { some: { content: { contains: q, mode: 'insensitive' } } } },
        { client: { firstName: { contains: q, mode: 'insensitive' } } },
        { client: { lastName: { contains: q, mode: 'insensitive' } } },
      ];
    }
    const [total, rows] = await Promise.all([
      this.prisma.chatConversation.count({ where }),
      this.prisma.chatConversation.findMany({
        where,
        orderBy: { lastActivityAt: 'desc' },
        skip: (page - 1) * INBOX_PAGE_SIZE,
        take: INBOX_PAGE_SIZE,
        select: {
          id: true,
          channel: true,
          lastActivityAt: true,
          totalMessages: true,
          attentionReason: true,
          attentionAt: true,
          assistantPausedAt: true,
          context: true,
          client: { select: { id: true, firstName: true, lastName: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { role: true, content: true, createdAt: true } },
        },
      }),
    ]);
    return {
      total,
      page,
      pageSize: INBOX_PAGE_SIZE,
      items: rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        name: displayName(r as any),
        clientId: r.client?.id ?? null,
        lastActivityAt: r.lastActivityAt,
        totalMessages: r.totalMessages,
        lastMessage: r.messages[0]
          ? { role: r.messages[0].role, preview: r.messages[0].content.slice(0, 160), at: r.messages[0].createdAt }
          : null,
        attention: r.attentionAt ? { reason: r.attentionReason, at: r.attentionAt } : null,
        paused: !!r.assistantPausedAt,
      })),
    };
  }

  async get(tenantId: string, id: string) {
    const row = await this.prisma.chatConversation.findFirst({
      where: { id, tenantId },
      select: {
        id: true,
        channel: true,
        createdAt: true,
        lastActivityAt: true,
        attentionReason: true,
        attentionAt: true,
        assistantPausedAt: true,
        context: true,
        client: { select: { id: true, firstName: true, lastName: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 500,
          select: { id: true, role: true, content: true, createdAt: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Conversación no encontrada');
    return {
      id: row.id,
      channel: row.channel,
      name: displayName(row as any),
      clientId: row.client?.id ?? null,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      attention: row.attentionAt ? { reason: row.attentionReason, at: row.attentionAt } : null,
      paused: !!row.assistantPausedAt,
      messages: row.messages,
    };
  }

  async pause(actor: InboxActor, id: string) {
    await this.mustExist(actor.tenantId, id);
    await this.prisma.chatConversation.updateMany({
      where: { id, tenantId: actor.tenantId, assistantPausedAt: null },
      data: { assistantPausedAt: new Date(), assistantPausedById: actor.id },
    });
    await this.audit('receptionist.conversation_paused', actor, id);
    return this.get(actor.tenantId, id);
  }

  async resume(actor: InboxActor, id: string) {
    await this.mustExist(actor.tenantId, id);
    await this.prisma.chatConversation.updateMany({
      where: { id, tenantId: actor.tenantId },
      data: { assistantPausedAt: null, assistantPausedById: null },
    });
    await this.audit('receptionist.conversation_resumed', actor, id);
    return this.get(actor.tenantId, id);
  }

  /** Attended: the salon took care of it. A later request notifies again. */
  async markAttended(actor: InboxActor, id: string) {
    await this.mustExist(actor.tenantId, id);
    await this.prisma.chatConversation.updateMany({
      where: { id, tenantId: actor.tenantId },
      data: { attentionAt: null },
    });
    await this.audit('receptionist.conversation_attended', actor, id);
    return this.get(actor.tenantId, id);
  }

  /** How many conversations are waiting for the salon (the menu badge). */
  async attentionCount(tenantId: string): Promise<number> {
    return this.prisma.chatConversation.count({ where: { tenantId, attentionAt: { not: null } } });
  }

  /**
   * Tells the salon that this conversation needs it. Claimed atomically:
   * the first request since it was last attended notifies, the rest do not.
   * Never throws: the client's reply must not depend on it.
   */
  async flagAttention(tenantId: string, conversationId: string, reason: AttentionReason): Promise<boolean> {
    try {
      const claimed = await this.prisma.chatConversation.updateMany({
        where: { id: conversationId, tenantId, attentionAt: null },
        data: { attentionAt: new Date(), attentionReason: reason },
      });
      if (claimed.count === 0) return false;
      await this.notifyManagers(tenantId, conversationId, reason);
      return true;
    } catch (err) {
      this.logger.warn(`Could not flag conversation ${conversationId}: ${(err as Error).message}`);
      return false;
    }
  }

  private async notifyManagers(tenantId: string, conversationId: string, reason: AttentionReason) {
    const [conversation, managers] = await Promise.all([
      this.prisma.chatConversation.findFirst({
        where: { id: conversationId, tenantId },
        select: { channel: true, context: true, client: { select: { firstName: true, lastName: true } } },
      }),
      this.prisma.user.findMany({
        where: { tenantId, role: { in: [UserRole.owner, UserRole.admin] }, isActive: true },
        select: { id: true, email: true, firstName: true },
      }),
    ]);
    const who = conversation ? displayName(conversation as any) : '';
    const channel = CHANNEL_TEXT[String(conversation?.channel)] ?? 'el asistente';
    const title = reason === 'client_asked_person' ? 'Una clienta quiere hablar con el salón' : 'El asistente no ha sabido responder';
    const message = `${who || 'Alguien'} ${REASON_TEXT[reason]} en ${channel}. El asistente le ha dado el teléfono del salón; puedes ver la conversación en Conversaciones.`;
    const link = `${INBOX_PAGE}?c=${conversationId}`;

    for (const m of managers) {
      await this.notifications
        ?.create({
          tenantId,
          userId: m.id,
          type: 'system_alert' as any,
          title,
          message,
          data: { kind: 'receptionist_attention', reason, conversationId, link },
        })
        .catch((e: Error) => this.logger.warn(`Attention notice to ${m.id} not created: ${e.message}`));
    }
    if (!this.email?.isConfigured()) return;
    for (const m of managers) {
      if (!m.email) continue;
      const res = await this.email
        .sendEmail({
          to: m.email,
          subject: title,
          html: `<p>Hola${m.firstName ? ` ${escapeHtml(m.firstName)}` : ''},</p>
<p>${escapeHtml(message)}</p>
<p><a href="${escapeHtml(panelUrl(link))}">Ver la conversación</a></p>`,
          idempotencyKey: `receptionist-attention-${conversationId}-${m.id}-${Date.now().toString().slice(0, -5)}`,
        })
        .catch((err: Error) => ({ success: false, error: err.message }));
      if (!res.success) this.logger.warn(`Attention email to a manager failed: ${(res as any).error ?? 'unknown'}`);
    }
  }

  private async mustExist(tenantId: string, id: string) {
    const row = await this.prisma.chatConversation.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!row) throw new NotFoundException('Conversación no encontrada');
  }

  private async audit(action: string, actor: InboxActor, conversationId: string) {
    await this.auditLog.record(action, {
      actorId: actor.id,
      actorRole: actor.role,
      tenantId: actor.tenantId,
      metadata: { conversationId },
    });
  }
}
