import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { SalonCopilotToolsService } from './tools/salon-copilot-tools';

/**
 * P2A-staff-copilot sprint 14: the human-in-the-loop gate for write
 * tools. Every write tool returns a pending `ActionApproval` instead
 * of executing immediately. The user must click "Approve" in the panel
 * (or the notification bell) within `expiresAt` (default 5 minutes) for
 * the tool to actually run.
 *
 * Key invariants (mirrored in the RFC §6):
 *   - The `toolInput` is frozen at create-time. The tool is re-executed
 *     at approval time with the same input — never a re-derived one.
 *   - Only the `ActionApproval.userId` can approve their own card.
 *     (Owner-overrides are intentionally not supported in v1.)
 *   - `expiresAt` is enforced lazily: a `pending` action past its
 *     expiry returns 410 Gone and is marked `expired` by the caller.
 *   - The tool is *re-run* on approve (not snapshotted). This means a
 *     re-check of permissions / stock / slot availability happens
 *     exactly when the user clicks, catching the "changed in the
 *     meantime" case (e.g. someone else filled the slot).
 */

export interface CreatePendingInput {
  tenantId: string;
  userId: string;
  conversationId: string;
  toolName: string;
  toolInput: unknown;
  preview: string;
}

export interface ResolvedApproval {
  id: string;
  status: 'approved' | 'rejected' | 'expired' | 'executed';
  toolName: string;
  preview: string | null;
  expiresAt: Date;
  resolvedAt: Date | null;
  resultSnapshot: unknown;
}

const APPROVAL_TTL_MS = 5 * 60 * 1000; // 5 minutes, per RFC §6

@Injectable()
export class ActionApprovalService {
  private readonly logger = new Logger(ActionApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly salonTools: SalonCopilotToolsService,
  ) {}

  // ------------------------------------------------------------------
  //  Create
  // ------------------------------------------------------------------

  /**
   * Persist a pending approval row. Returns the id + preview; the
   * caller (AssistantService) then writes an `AssistantMessage` with
   * role=approval pointing at this id.
   */
  async createPending(input: CreatePendingInput): Promise<{ id: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
    const row = await this.prisma.actionApproval.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        toolName: input.toolName,
        toolInput: input.toolInput as any,
        preview: input.preview,
        expiresAt,
        status: 'pending',
      },
      select: { id: true, expiresAt: true },
    });
    return row;
  }

  // ------------------------------------------------------------------
  //  Read
  // ------------------------------------------------------------------

  async listForUser(userId: string, tenantId: string) {
    return this.prisma.actionApproval.findMany({
      where: { userId, tenantId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        toolName: true,
        toolInput: true,
        preview: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  async getForUser(id: string, userId: string) {
    const row = await this.prisma.actionApproval.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('approval_not_found');
    if (row.userId !== userId) throw new ForbiddenException('not_owner');
    return row;
  }

  // ------------------------------------------------------------------
  //  Resolve (approve / reject / expire)
  // ------------------------------------------------------------------

  /**
   * Approve and execute the pending tool. Returns the tool result
   * (the same shape the LLM would have received if it had run the
   * tool synchronously). The DB row is marked `executed` and the
   * `resultSnapshot` is persisted for the audit log.
   */
  async approveAndExecute(
    id: string,
    userId: string,
    ctx: { tenantId: string; role: string; userId: string },
  ): Promise<ResolvedApproval> {
    const row = await this.getForUser(id, userId);
    if (row.status !== 'pending') {
      throw new BadRequestException(`approval_not_pending:${row.status}`);
    }
    if (row.expiresAt.getTime() < Date.now()) {
      await this.prisma.actionApproval.update({
        where: { id },
        data: { status: 'expired', resolvedAt: new Date() },
      });
      throw new BadRequestException('approval_expired');
    }

    // Re-execute the tool with the FROZEN input. Permission checks
    // happen again at execute time (the role / professional mapping
    // could have changed in the last 5 minutes).
    const toolCtx = {
      prisma: this.prisma,
      tenantId: row.tenantId,
      userId: row.userId,
      role: ctx.role as any,
    };
    let result: unknown;
    let execStatus: 'executed' | 'rejected' = 'executed';
    try {
      result = await this.salonTools.execute(row.toolName, row.toolInput, toolCtx);
      // If the tool refused permission at execute time, surface that as
      // a "rejected" status (the action was not taken).
      if (
        result &&
        typeof result === 'object' &&
        (result as any).error === 'forbidden'
      ) {
        execStatus = 'rejected';
      }
    } catch (err) {
      this.logger.error(
        `Tool ${row.toolName} failed during approval ${id}: ${(err as Error).message}`,
      );
      result = { error: 'tool_failure', message: (err as Error).message };
      execStatus = 'rejected';
    }

    const updated = await this.prisma.actionApproval.update({
      where: { id },
      data: {
        status: execStatus,
        resolvedAt: new Date(),
        resultSnapshot: result as any,
        resolvedById: userId,
      },
    });

    return {
      id: updated.id,
      status: updated.status as ResolvedApproval['status'],
      toolName: updated.toolName,
      preview: updated.preview,
      expiresAt: updated.expiresAt,
      resolvedAt: updated.resolvedAt,
      resultSnapshot: updated.resultSnapshot,
    };
  }

  /**
   * Reject without executing. The LLM is told the user declined and
   * can offer alternatives.
   */
  async reject(id: string, userId: string, _reason?: string): Promise<ResolvedApproval> {
    const row = await this.getForUser(id, userId);
    if (row.status !== 'pending') {
      throw new BadRequestException(`approval_not_pending:${row.status}`);
    }
    const updated = await this.prisma.actionApproval.update({
      where: { id },
      data: {
        status: 'rejected',
        resolvedAt: new Date(),
        resolvedById: userId,
      },
    });
    return {
      id: updated.id,
      status: updated.status as ResolvedApproval['status'],
      toolName: updated.toolName,
      preview: updated.preview,
      expiresAt: updated.expiresAt,
      resolvedAt: updated.resolvedAt,
      resultSnapshot: updated.resultSnapshot,
    };
  }

  /**
   * Lazy expiry: called by AssistantService.sendMessage when it
   * notices a `pending` action whose expiresAt is in the past. Marks
   * the row expired and returns the conversation-update text the LLM
   * needs to know.
   */
  async expireIfStale(id: string): Promise<boolean> {
    const row = await this.prisma.actionApproval.findUnique({ where: { id } });
    if (!row) return false;
    if (row.status !== 'pending') return false;
    if (row.expiresAt.getTime() >= Date.now()) return false;
    await this.prisma.actionApproval.update({
      where: { id },
      data: { status: 'expired', resolvedAt: new Date() },
    });
    return true;
  }
}
