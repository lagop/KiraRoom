import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { runUnscoped } from '../common/tenancy/tenant.context';
import { MonitoredJob } from '../common/ops-alerts/ops-alert-sink';

/**
 * How long a Copilot conversation is kept after its last message, in days
 * (Copilot audit M4, decision D2). The privacy policy, the terms and the
 * staff guide say the same (frontend lib/salon-legal.ts,
 * COPILOT_CONVERSATION_RETENTION_DAYS).
 */
export const COPILOT_CONVERSATION_RETENTION_DAYS = 90;

/**
 * How long an approved, rejected or expired copilot action is kept: the
 * record of who approved what (the staff guide promises one year). Pending
 * ones expire after 5 minutes and go with the same rule.
 */
export const COPILOT_ACTION_RETENTION_DAYS = 365;

/** Rows deleted per statement, so one night's backlog is never one huge delete. */
const BATCH = 500;

export function copilotRetentionCutoff(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/**
 * Deletes the team's Copilot conversations with no activity for 90 days
 * (their messages and feedback go with them: onDelete Cascade), and the
 * action records older than a year.
 *
 * They were kept for ever, while the staff guide promised 90 days: what the
 * team asked about clients (names, allergies, visits) and what the model
 * answered stayed with no limit. Runs daily at 03:50 UTC, after the
 * receptionist's conversation clean-up.
 */
@Injectable()
export class CopilotRetentionScheduler {
  private readonly logger = new Logger(CopilotRetentionScheduler.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron('50 3 * * *')
  @MonitoredJob('CopilotRetentionScheduler.purge')
  async daily(): Promise<{ conversations: number; actions: number }> {
    return this.purge(new Date());
  }

  async purge(now: Date = new Date()): Promise<{ conversations: number; actions: number }> {
    const conversationCutoff = copilotRetentionCutoff(COPILOT_CONVERSATION_RETENTION_DAYS, now);
    const actionCutoff = copilotRetentionCutoff(COPILOT_ACTION_RETENTION_DAYS, now);
    let conversations = 0;
    let actions = 0;
    await runUnscoped(async () => {
      for (;;) {
        const batch = await this.prisma.assistantConversation.findMany({
          where: { updatedAt: { lt: conversationCutoff } },
          select: { id: true },
          take: BATCH,
        });
        if (batch.length === 0) break;
        const { count } = await this.prisma.assistantConversation.deleteMany({
          where: { id: { in: batch.map((c) => c.id) }, updatedAt: { lt: conversationCutoff } },
        });
        conversations += count;
        if (batch.length < BATCH || count === 0) break;
      }
      for (;;) {
        const batch = await this.prisma.actionApproval.findMany({
          where: { createdAt: { lt: actionCutoff } },
          select: { id: true },
          take: BATCH,
        });
        if (batch.length === 0) break;
        const { count } = await this.prisma.actionApproval.deleteMany({
          where: { id: { in: batch.map((a) => a.id) }, createdAt: { lt: actionCutoff } },
        });
        actions += count;
        if (batch.length < BATCH || count === 0) break;
      }
    });
    if (conversations + actions > 0) {
      this.logger.log(`Copilot retention: ${conversations} conversation(s), ${actions} action record(s) deleted`);
    }
    return { conversations, actions };
  }
}
