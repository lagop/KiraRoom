import { Controller, ForbiddenException, Get, Req } from "@nestjs/common";
import { UserRole, VerifactuRecordStatus } from "@prisma/client";
import { Public } from "../../../auth/decorators/public.decorator";
import { Roles, SALON_TEAM } from "../../../auth/decorators/roles.decorator";
import { PrismaService } from "../../../common/prisma/prisma.service";
import { fiscalSubmissionAvailable } from "../fiscal-availability";
import { SYSTEM, declarationDetails, environment, producer } from "./config";

/**
 * What the panel shows about VERI*FACTU, and the public data of the
 * software's declaración responsable.
 */
@Controller("verifactu")
export class VerifactuController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The salon's queue. Orden HAC/1177/2024 art. 16.4: while records are
   * waiting because of an incident, the system must say so and how many.
   * The panel asks on every page: a salon that has not activated it gets its
   * answer without a count.
   */
  @Get("status")
  @Roles(...SALON_TEAM)
  async status(@Req() req: any) {
    const tenantId: string | undefined = req.user?.tenantId;
    if (!tenantId) throw new ForbiddenException();
    const [tenant, chain, certificate] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { fiscalMode: true } }),
      this.prisma.verifactuChain.findUnique({ where: { tenantId } }),
      this.prisma.fiscalCertificate.findFirst({
        where: { tenantId, isActive: true },
        orderBy: { createdAt: "desc" },
        select: { alias: true, subject: true, notAfter: true, certificateType: true },
      }),
    ]);
    const common = {
      available: fiscalSubmissionAvailable(),
      environment: environment(),
      incidentSince: chain?.incidentSince ?? null,
      lastError: chain?.lastError ?? null,
      nextSendAt: chain?.nextSendAt ?? null,
      // Its subject names a person and their NIF: the owner's, like the
      // certificates list. The team only needs the queue (art. 16.4).
      certificate: req.user.role === UserRole.owner ? (certificate ?? null) : null,
    };
    if (tenant?.fiscalMode !== "verifactu" || !chain) {
      return { ...common, active: false, pending: 0, accepted: 0, acceptedWithErrors: 0, rejected: 0 };
    }
    const [counts, rejected] = await Promise.all([
      this.prisma.verifactuRecord.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
      this.rejectedInvoices(tenantId),
    ]);
    const count = (s: VerifactuRecordStatus) => counts.find((c) => c.status === s)?._count ?? 0;
    return {
      ...common,
      active: true,
      pending: count(VerifactuRecordStatus.pending),
      accepted: count(VerifactuRecordStatus.accepted),
      acceptedWithErrors: count(VerifactuRecordStatus.accepted_with_errors),
      rejected,
    };
  }

  /**
   * Invoices whose newest record is rejected: a record that was then
   * corrected or annulled stays rejected for ever, and no longer needs
   * anything. From the salon's rejected records only, by index, however long
   * its chain is.
   */
  private async rejectedInvoices(tenantId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM verifactu_records r
      WHERE r."tenantId" = ${tenantId}
        AND r.status = 'rejected'
        AND r."invoiceId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM verifactu_records newer
          WHERE newer."invoiceId" = r."invoiceId" AND newer.sequence > r.sequence
        )`;
    return row?.count ?? 0;
  }

  /**
   * The identification of the billing system for its declaración
   * responsable (Orden HAC/1177/2024 art. 15), which must be readable both
   * inside the software and outside it.
   */
  @Get("declaracion")
  @Public()
  declaracion() {
    return {
      system: SYSTEM,
      producer: producer(),
      ...declarationDetails(),
      environment: environment(),
    };
  }
}
