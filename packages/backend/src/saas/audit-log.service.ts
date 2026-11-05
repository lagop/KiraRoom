import { Injectable } from "@nestjs/common";
import type { Prisma, UserRole } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { currentRequestActor } from "../common/tenancy/tenant.context";

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
    const attributed = attributeToSupport(params);
    const row = await client.auditLog.create({
      data: {
        action,
        actorId: attributed.actorId,
        actorRole: attributed.actorRole,
        tenantId: params.tenantId,
        metadata: attributed.metadata as any,
      },
      select: { id: true },
    });
    return row;
  }
}

/**
 * Audit 8, C4: in a support session the request is signed in as the salon's
 * owner, but the person acting is the platform owner who entered. Every row
 * written on such a request names the saas_owner as the actor, with the
 * owner as "on behalf of" and the session's id, without each call site
 * having to remember (they pass the signed-in user, as always).
 *
 * A row for someone else (a different actorId than the signed-in user) keeps
 * its actor and still says which support session wrote it.
 */
export function attributeToSupport(params: {
  actorId: string;
  actorRole: UserRole;
  metadata?: Record<string, unknown>;
}): { actorId: string; actorRole: UserRole; metadata: Record<string, unknown> } {
  const metadata = { ...(params.metadata ?? {}) };
  const actor = currentRequestActor();
  if (!actor?.impersonatedBy) return { actorId: params.actorId, actorRole: params.actorRole, metadata };
  const support = { impersonatedBy: actor.impersonatedBy, impersonationId: actor.impersonationId ?? null };
  if (params.actorId !== actor.userId) return { actorId: params.actorId, actorRole: params.actorRole, metadata: { ...metadata, ...support } };
  return {
    actorId: actor.impersonatedBy,
    actorRole: "saas_owner" as UserRole,
    metadata: { ...metadata, ...support, onBehalfOf: { userId: params.actorId, role: params.actorRole } },
  };
}
