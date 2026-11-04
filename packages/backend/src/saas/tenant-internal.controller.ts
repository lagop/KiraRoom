import { Body, Controller, NotFoundException, Param, ParseUUIDPipe, Patch, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SaasOwnerGuard } from "./guards/saas-owner.guard";
import { SaasOwner } from "./decorators/saas-owner.decorator";
import { AuditLogService } from "./audit-log.service";
import { SetTenantInternalDto } from "./dto/set-tenant-internal.dto";
import { TENANT_ACTIVE_WHERE } from "./saas.constants";

export const TENANT_INTERNAL_AUDIT_ACTION = "tenant.internal.change";

/**
 * Marks a salon as one of KiraRoom's own (audit 8 D11): internal salons are
 * left out of platform figures and alerts (countableTenantWhere). Kept apart
 * from SaasController so the flag has a single, audited way to change.
 */
@ApiTags("SaaS Management")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SaasOwnerGuard)
@SaasOwner()
@Controller("saas")
export class TenantInternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Patch("tenants/:id/internal")
  @ApiOperation({ summary: "Mark a salon as internal / test, or not (SaaS Owner only)" })
  @ApiResponse({ status: 200, description: "The salon's id and its new flag" })
  @ApiResponse({ status: 404, description: "Tenant not found" })
  async setInternal(
    @Req() req: any,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetTenantInternalDto,
  ): Promise<{ id: string; isInternal: boolean }> {
    const existing = await this.prisma.tenant.findFirst({
      where: { id, ...TENANT_ACTIVE_WHERE },
      select: { id: true, slug: true, isInternal: true },
    });
    if (!existing) throw new NotFoundException("Tenant not found");
    if (existing.isInternal === dto.isInternal) {
      return { id, isInternal: existing.isInternal };
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.tenant.update({
        where: { id },
        data: { isInternal: dto.isInternal },
        select: { id: true, isInternal: true },
      });
      await this.auditLog.record(
        TENANT_INTERNAL_AUDIT_ACTION,
        {
          actorId: req.user.id,
          actorRole: req.user.role as UserRole,
          tenantId: id,
          metadata: { slug: existing.slug, from: existing.isInternal, to: dto.isInternal },
        },
        tx,
      );
      return updated;
    });
  }
}
