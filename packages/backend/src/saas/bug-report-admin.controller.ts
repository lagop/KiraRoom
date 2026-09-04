import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Req,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { BugReportStatus, Prisma } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SaasOwnerGuard } from "./guards/saas-owner.guard";
import { SaasOwner } from "./decorators/saas-owner.decorator";
import { PrismaService } from "../common/prisma/prisma.service";
import {
  ListBugReportsQueryDto,
  UpdateBugReportDto,
} from "./dto/bug-report.dto";
import { AuditLogService } from "./audit-log.service";
import { UserRole } from "@prisma/client";

interface PaginatedResult<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

@ApiTags("SaaS Management")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SaasOwnerGuard)
@SaasOwner()
@Controller("saas/bug-reports")
export class BugReportAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "List bug reports submitted from any tenant (SaaS Owner only)",
  })
  @ApiResponse({ status: 200, description: "Paginated bug reports" })
  async list(
    @Query() query: ListBugReportsQueryDto,
    @Query("page") pageRaw?: string,
    @Query("limit") limitRaw?: string,
  ): Promise<PaginatedResult<any>> {
    const page = Math.max(1, parseInt(pageRaw ?? "1", 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(limitRaw ?? "20", 10) || 20),
    );

    const where: Prisma.BugReportWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.tenantId) where.tenantId = query.tenantId;
    if (query.search) {
      where.OR = [
        { subject: { contains: query.search, mode: "insensitive" } },
        { description: { contains: query.search, mode: "insensitive" } },
        { email: { contains: query.search, mode: "insensitive" } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.bugReport.count({ where }),
      this.prisma.bugReport.findMany({
        where,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          tenant: { select: { id: true, name: true, slug: true } },
          author: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              role: true,
            },
          },
        },
      }),
    ]);

    return {
      data: rows,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  @Get("stats")
  @ApiOperation({ summary: "Bug-report counters by status (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Counts grouped by status" })
  async stats(): Promise<Record<BugReportStatus, number> & { total: number }> {
    const groups = await this.prisma.bugReport.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const counts: Record<BugReportStatus, number> = {
      open: 0,
      triaged: 0,
      in_progress: 0,
      resolved: 0,
      wont_fix: 0,
      duplicate: 0,
    };
    for (const g of groups) counts[g.status] = g._count._all;
    return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a bug report by ID (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "Full bug report detail" })
  @ApiResponse({ status: 404, description: "Report not found" })
  async detail(@Param("id") id: string) {
    const report = await this.prisma.bugReport.findUnique({
      where: { id },
      include: {
        tenant: { select: { id: true, name: true, slug: true } },
        author: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            role: true,
          },
        },
      },
    });
    if (!report) throw new NotFoundException("Bug report not found");
    return report;
  }

  @Patch(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Update a bug report's status / resolution (SaaS Owner only)",
  })
  @ApiResponse({ status: 200, description: "Updated bug report" })
  @ApiResponse({ status: 404, description: "Report not found" })
  async update(
    @Param("id") id: string,
    @Body() dto: UpdateBugReportDto,
    @Req() req: any,
  ) {
    const existing = await this.prisma.bugReport.findUnique({
      where: { id },
      select: { id: true, status: true, tenantId: true },
    });
    if (!existing) throw new NotFoundException("Bug report not found");

    const isResolvedLike =
      dto.status === "resolved" ||
      dto.status === "wont_fix" ||
      dto.status === "duplicate";

    const updated = await this.prisma.bugReport.update({
      where: { id },
      data: {
        status: dto.status,
        resolution: dto.resolution ?? null,
        resolvedById: isResolvedLike ? req.user.id : null,
        resolvedAt: isResolvedLike ? new Date() : null,
      },
    });

    await this.auditLog.record("bug_report.status_changed", {
      actorId: req.user.id,
      actorRole: req.user.role as UserRole,
      tenantId: existing.tenantId ?? undefined,
      metadata: {
        bugReportId: id,
        from: existing.status,
        to: dto.status,
        resolution: dto.resolution ?? null,
      },
    });

    return updated;
  }
}