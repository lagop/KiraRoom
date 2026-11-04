import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * How long a receptionist conversation is kept after its last message, in
 * months. One number for every channel (the salon's web chat, WhatsApp,
 * Messenger, Instagram, Telegram).
 *
 * 12 is a default, not a decision: the retention period is the owner's to
 * set (the audit suggested 6 to 12 months). Change it here.
 */
export const CONVERSATION_RETENTION_MONTHS = 12;

/** Conversations deleted per statement, so one night's backlog is never one huge delete. */
const BATCH = 500;

/** The last moment of activity a conversation may have had and still be kept. */
export function conversationRetentionCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - CONVERSATION_RETENTION_MONTHS);
  return cutoff;
}

/**
 * Deletes receptionist conversations with no activity for
 * CONVERSATION_RETENTION_MONTHS, whatever their status. Their messages and
 * intent history go with them (onDelete: Cascade).
 *
 * Until now they were kept for ever: the phone, the WhatsApp profile name and
 * everything written -- which can include health details such as allergies
 * or a pregnancy -- with no time limit, and the conversations that cannot be
 * tied to a client (Messenger, Instagram, Telegram, a visitor who never
 * booked) were never deleted by anything.
 *
 * Runs daily at 03:45 UTC, after the other 03:00-03:30 clean-ups. Like the
 * other retention jobs (SaaSRetentionScheduler, notifications) it logs a
 * count and writes no audit row: there is no actor, and the rule is this
 * file.
 */
@Injectable()
export class ConversationRetentionScheduler {
  private readonly logger = new Logger(ConversationRetentionScheduler.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron('45 3 * * *')
  async purgeInactiveConversations(now: Date = new Date()): Promise<number> {
    const cutoff = conversationRetentionCutoff(now);
    let total = 0;
    try {
      for (;;) {
        const batch = await this.prisma.chatConversation.findMany({
          where: { lastActivityAt: { lt: cutoff } },
          select: { id: true },
          take: BATCH,
        });
        if (batch.length === 0) break;
        const { count } = await this.prisma.chatConversation.deleteMany({
          where: { id: { in: batch.map((c) => c.id) }, lastActivityAt: { lt: cutoff } },
        });
        total += count;
        if (batch.length < BATCH || count === 0) break;
      }
    } catch (err) {
      this.logger.error(`Conversation retention purge failed after ${total}: ${(err as Error).message}`);
      return total;
    }
    if (total > 0) {
      this.logger.log(
        `Deleted ${total} receptionist conversation(s) inactive for over ${CONVERSATION_RETENTION_MONTHS} months`,
      );
    }
    return total;
  }
}
