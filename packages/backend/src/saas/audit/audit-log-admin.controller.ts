import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";
import type { Prisma } from "@prisma/client";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { SaasOwnerGuard } from "../guards/saas-owner.guard";
import { SaasOwner } from "../decorators/saas-owner.decorator";
import { PrismaService } from "../../common/prisma/prisma.service";

export class AuditLogFilterDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number = 50;

  /** One salon, by id (the link from a salon's page). */
  @IsOptional() @IsUUID()
  tenantId?: string;

  /** Salons whose name or web address contains this. */
  @IsOptional() @IsString() @MaxLength(100)
  tenant?: string;

  /** One actor, by id. */
  @IsOptional() @IsUUID()
  actorId?: string;

  /** Actors whose email or name contains this. */
  @IsOptional() @IsString() @MaxLength(100)
  actor?: string;

  /** The exact action ("tenant.update"), or its start ("tenant."). */
  @IsOptional() @IsString() @MaxLength(100)
  action?: string;

  /** From this day (YYYY-MM-DD, UTC) inclusive. */
  @IsOptional() @IsDateString()
  from?: string;

  /** Up to this day (YYYY-MM-DD, UTC) inclusive. */
  @IsOptional() @IsDateString()
  to?: string;
}

const ACTOR_SELECT = { id: true, email: true, firstName: true, lastName: true, role: true } as const;

/** The where clause of a filter; exported for the spec. */
export function auditLogWhere(f: AuditLogFilterDto): Prisma.AuditLogWhereInput {
  const and: Prisma.AuditLogWhereInput[] = [];
  if (f.tenantId) and.push({ tenantId: f.tenantId });
  if (f.tenant?.trim()) {
    const q = f.tenant.trim();
    and.push({
      tenant: { OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }] },
    });
  }
  if (f.actorId) and.push({ actorId: f.actorId });
  if (f.actor?.trim()) {
    const q = f.actor.trim();
    and.push({
      actor: {
        OR: [
          { email: { contains: q, mode: "insensitive" } },
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } },
        ],
      },
    });
  }
  if (f.action?.trim()) {
    const a = f.action.trim();
    and.push(a.endsWith(".") ? { action: { startsWith: a } } : { action: a });
  }
  if (f.from || f.to) {
    const createdAt: Prisma.DateTimeFilter = {};
    if (f.from) createdAt.gte = new Date(`${f.from.slice(0, 10)}T00:00:00.000Z`);
    if (f.to) createdAt.lte = new Date(`${f.to.slice(0, 10)}T23:59:59.999Z`);
    and.push({ createdAt });
  }
  return and.length ? { AND: and } : {};
}

/**
 * Audit 8, C9: the audit log, read-only, for the platform owner. Every
 * console action that changes something writes a row, as do support
 * sessions and some salon actions; until now nobody could read them.
 * Nothing here edits or deletes a row.
 */
@ApiTags("SaaS Management")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SaasOwnerGuard)
@SaasOwner()
@Controller("saas/audit-logs")
export class AuditLogAdminController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: "Audit log, newest first, with filters (SaaS Owner only)" })
  async list(@Query() filter: AuditLogFilterDto) {
    const page = filter.page ?? 1;
    const limit = filter.limit ?? 50;
    const where = auditLogWhere(filter);
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          createdAt: true,
          action: true,
          actorRole: true,
          tenantId: true,
          metadata: true,
          actor: { select: ACTOR_SELECT },
          tenant: { select: { id: true, name: true, slug: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    // "En nombre de": the salon user a support session acted as (C4).
    const behalfIds = [
      ...new Set(
        rows
          .map((r) => (r.metadata as any)?.onBehalfOf?.userId)
          .filter((id): id is string => typeof id === "string"),
      ),
    ];
    const behalf = behalfIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: behalfIds } }, select: ACTOR_SELECT })
      : [];
    const byId = new Map(behalf.map((u) => [u.id, u]));

    return {
      data: rows.map((r) => ({
        ...r,
        onBehalfOf: byId.get((r.metadata as any)?.onBehalfOf?.userId) ?? null,
      })),
      meta: { total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  /** The actions that exist in the log, for the filter's list. */
  @Get("actions")
  @ApiOperation({ summary: "Distinct audit-log actions (SaaS Owner only)" })
  async actions(): Promise<{ data: string[] }> {
    const rows = await this.prisma.auditLog.findMany({
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    });
    return { data: rows.map((r) => r.action) };
  }
}
