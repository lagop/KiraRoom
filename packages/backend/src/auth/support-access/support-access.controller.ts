import { Body, Controller, Get, Injectable, Patch } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { IsBoolean } from "class-validator";
import { PrismaService } from "../../common/prisma/prisma.service";
import { AuditLogService } from "../../saas/audit-log.service";
import { Roles } from "../decorators/roles.decorator";
import { CurrentUser } from "../decorators/current-user.decorator";
import { AllowWhenReadOnly } from "../../common/decorators/allow-when-read-only.decorator";
import { NotDuringSupport } from "../../common/decorators/not-during-support.decorator";
import {
  SUPPORT_SESSION_END_ACTION,
  SUPPORT_SESSION_START_ACTION,
  supportAccessAllowed,
  supportSessionsFromAudit,
} from "./support-access";

export class UpdateSupportAccessDto {
  @IsBoolean()
  allowed!: boolean;
}

/** How far back Ajustes > Seguridad lists support sessions, and how many. */
const SESSIONS_DAYS = 180;
const SESSIONS_MAX = 20;

@Injectable()
export class SupportAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async get(tenantId: string, now: Date = new Date()) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { allowSupportAccess: true },
    });
    const rows = await this.prisma.auditLog.findMany({
      where: {
        tenantId,
        action: { in: [SUPPORT_SESSION_START_ACTION, SUPPORT_SESSION_END_ACTION] },
        createdAt: { gte: new Date(now.getTime() - SESSIONS_DAYS * 86_400_000) },
      },
      orderBy: { createdAt: "desc" },
      take: SESSIONS_MAX * 3,
      select: { id: true, createdAt: true, actorId: true, action: true, metadata: true },
    });
    const actorIds = [...new Set(rows.map((r) => r.actorId))];
    const people = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const names = new Map(people.map((p) => [p.id, `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "Soporte de KiraRoom"]));
    return {
      allowed: supportAccessAllowed(tenant),
      sessions: supportSessionsFromAudit(rows, names, now).slice(0, SESSIONS_MAX),
    };
  }

  async set(tenantId: string, actor: { id: string; role: UserRole }, allowed: boolean) {
    const before = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { allowSupportAccess: true },
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { id: tenantId }, data: { allowSupportAccess: allowed } });
      if (supportAccessAllowed(before) !== allowed) {
        await this.auditLog.record(
          "tenant.support_access.updated",
          { actorId: actor.id, actorRole: actor.role, tenantId, metadata: { allowed } },
          tx,
        );
      }
    });
    return this.get(tenantId);
  }
}

/**
 * Ajustes > Seguridad: "Permitir que soporte de KiraRoom entre en mi panel"
 * and the salon's recent support sessions (audit 8 D2). Owner only; a
 * support session sees it but cannot change it.
 */
@ApiTags("Settings")
@ApiBearerAuth()
@Roles(UserRole.owner)
@Controller("settings/support-access")
export class SupportAccessController {
  constructor(private readonly supportAccess: SupportAccessService) {}

  @Get()
  @ApiOperation({ summary: "Whether KiraRoom support may enter the panel, and recent support sessions" })
  get(@CurrentUser() user: { tenantId: string }) {
    return this.supportAccess.get(user.tenantId);
  }

  @NotDuringSupport()
  @Patch()
  // A security choice: it stays the owner's in read-only mode too.
  @AllowWhenReadOnly()
  @ApiOperation({ summary: "Allow or refuse KiraRoom support sessions (owner)" })
  update(@CurrentUser() user: { id: string; role: UserRole; tenantId: string }, @Body() dto: UpdateSupportAccessDto) {
    return this.supportAccess.set(user.tenantId, { id: user.id, role: user.role }, dto.allowed);
  }
}
