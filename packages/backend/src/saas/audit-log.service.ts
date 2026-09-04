import { Injectable } from "@nestjs/common";
import type { Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";

/**
 * Audit trail for sensitive platform actions.
 *
 * Single entry point so all `audit_logs` writes share the same shape
 * (actor id, actor role, optional tenant id, action verb, free-form
 * metadata). Future actions — e.g. `tenant.suspend`, `tenant.reactivate`,
 * `plan.changed` — go through this service instead of constructing a
 * `prisma.auditLog.create` literal in the call site.
 *
 * Append-only: this service never updates or deletes rows. The DB FK
 * is also `onDelete: Restrict` on the actor, so a deletion attempt
 * surfaces as a P2003 instead of corrupting the trail.
 *
 * For atomicity with a business write (e.g. soft-delete a tenant and
 * record the audit row in the same transaction), pass a `Prisma
 * TransactionClient` as the second argument:
 *
 *   await this.prisma.$transaction(async (tx) => {
 *     await tx.tenant.update(...);
 *     await this.auditLog.record("tenant.soft_delete", {...}, tx);
 *   });
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    action: string,
    params: {
      actorId: string;
      actorRole: UserRole;
      tenantId?: string;
      metadata?: Record<string, unknown>;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string }> {
    const client = tx ?? this.prisma;
    const row = await client.auditLog.create({
      data: {
        action,
        actorId: params.actorId,
        actorRole: params.actorRole,
        tenantId: params.tenantId,
        metadata: (params.metadata ?? {}) as any,
      },
      select: { id: true },
    });
    return row;
  }
}
