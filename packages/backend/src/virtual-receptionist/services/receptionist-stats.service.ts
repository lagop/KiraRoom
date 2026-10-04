import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

const CHANNELS = ['web', 'whatsapp', 'facebook', 'instagram', 'telegram'] as const;
type Channel = (typeof CHANNELS)[number];

export interface ReceptionistStats {
  /** Window the numbers cover, in days, ending now. */
  days: number;
  since: string;
  /** Conversations with activity in the window. */
  conversations: number;
  byChannel: Record<Channel, number>;
  /** Messages written in the window: by clients and by the receptionist. */
  messages: { fromClients: number; fromReceptionist: number };
  /** Appointments the receptionist booked in those conversations. */
  bookings: number;
  /** Conversations passed to the salon's team (a complaint, the AI cap...). */
  handedOff: number;
  /**
   * Average time to answer, over the replies that recorded it. Null when
   * none did: replies before this was recorded have no time.
   */
  avgResponseMs: number | null;
}

/**
 * The receptionist's numbers for the salon's panel, read from the tenant's
 * own conversations.
 *
 * GET /virtual-receptionist/stats used to return fixed figures
 * (avgResponseTime 1500, handoffRate 15.2, faqHitRate 35.8, bookings 0) next
 * to counts taken across no tenant at all, and the channels page showed
 * process-wide counters -- every salon's messages since the last restart --
 * as if they were the salon's own. Each figure here is a query on the
 * tenant's rows; there is no FAQ hit rate because nothing records one per
 * salon.
 */
@Injectable()
export class ReceptionistStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async forTenant(tenantId: string, days = 30): Promise<ReceptionistStats> {
    const span = Math.min(Math.max(Math.floor(days) || 30, 1), 365);
    const since = new Date(Date.now() - span * 24 * 60 * 60 * 1000);
    const active = { tenantId, lastActivityAt: { gte: since } };

    const [byChannelRows, byRoleRows, handedOff, booked, avg] = await Promise.all([
      this.prisma.chatConversation.groupBy({
        by: ['channel'],
        where: active,
        _count: { id: true },
      }),
      this.prisma.chatMessage.groupBy({
        by: ['role'],
        where: { createdAt: { gte: since }, conversation: { tenantId } },
        _count: { id: true },
      }),
      this.prisma.chatConversation.count({
        where: { ...active, OR: [{ status: 'handoff' }, { hasHandoff: true }] },
      }),
      // create_appointment keeps a per-conversation counter in the
      // conversation state (receptionist-booking.ts); appointments
      // themselves only say "online", like the booking page's.
      this.prisma.chatConversation.findMany({
        where: { ...active, context: { path: ['chatBookings'], gt: 0 } },
        select: { context: true },
      }),
      this.prisma.chatMessage.aggregate({
        where: {
          createdAt: { gte: since },
          role: 'assistant',
          responseTime: { not: null },
          conversation: { tenantId },
        },
        _avg: { responseTime: true },
      }),
    ]);

    const byChannel = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<Channel, number>;
    let conversations = 0;
    for (const row of byChannelRows as Array<{ channel: string; _count: { id: number } }>) {
      conversations += row._count.id;
      if ((CHANNELS as readonly string[]).includes(row.channel)) byChannel[row.channel as Channel] += row._count.id;
    }

    const messages = { fromClients: 0, fromReceptionist: 0 };
    for (const row of byRoleRows as Array<{ role: string; _count: { id: number } }>) {
      if (row.role === 'user') messages.fromClients += row._count.id;
      if (row.role === 'assistant') messages.fromReceptionist += row._count.id;
    }

    const bookings = (booked as Array<{ context: unknown }>).reduce((sum, row) => {
      const n = Number((row.context as any)?.chatBookings ?? 0);
      return sum + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);

    const avgMs = (avg as any)?._avg?.responseTime;
    return {
      days: span,
      since: since.toISOString(),
      conversations,
      byChannel,
      messages,
      bookings,
      handedOff,
      avgResponseMs: typeof avgMs === 'number' ? Math.round(avgMs) : null,
    };
  }
}
