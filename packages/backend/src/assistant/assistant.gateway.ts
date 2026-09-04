import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * P2A-staff-copilot: the AssistantGateway is the abstraction over how
 * a conversation thread is delivered to the panel. Sprint 12 keeps it
 * tiny: it just hydrates the `lastReadAt` of the user on read so the
 * notification bell can later show "X unread" (sprint 14+).
 *
 * In the future this is where SSE / WebSocket transport would live.
 * For now the panel polls /assistant/messages every 1.5 s, so the
 * gateway only needs to mark reads.
 */
@Injectable()
export class AssistantGateway {
  private readonly logger = new Logger(AssistantGateway.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mark all messages of a conversation as read by the calling user.
   * We do this by bumping the conversation's `updatedAt` to act as a
   * "last read" cursor — the panel compares the timestamp to decide
   * whether to show a "new" badge.
   */
  async markRead(conversationId: string, userId: string): Promise<void> {
    // P2A-copilot-permission: the user must own the conversation.
    const owns = await this.prisma.assistantConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!owns) {
      this.logger.warn(`markRead denied: user ${userId} does not own ${conversationId}`);
      return;
    }
    // No separate `lastReadAt` column in sprint 12; the panel can
    // decide "unread = message.createdAt > conversation.updatedAt" until
    // we add a proper read-receipt table in sprint 14.
    await this.prisma.assistantConversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
  }
}
