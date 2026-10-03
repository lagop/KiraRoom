import { Controller, Get, Req } from "@nestjs/common";
import { VerifactuRecordStatus } from "@prisma/client";
import { Public } from "../../../auth/decorators/public.decorator";
import { Roles, SALON_TEAM } from "../../../auth/decorators/roles.decorator";
import { PrismaService } from "../../../common/prisma/prisma.service";
import { SYSTEM, declarationDetails, environment, producer, verifactuAvailable } from "./config";

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
   */
  @Get("status")
  @Roles(...SALON_TEAM)
  async status(@Req() req: any) {
    const tenantId: string = req.user.tenantId;
    const [tenant, chain, counts, certificate] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { fiscalMode: true } }),
      this.prisma.verifactuChain.findUnique({ where: { tenantId } }),
      this.prisma.verifactuRecord.groupBy({ by: ["status"], where: { tenantId }, _count: true }),
      this.prisma.fiscalCertificate.findFirst({
        where: { tenantId, isActive: true },
        orderBy: { createdAt: "desc" },
        select: { alias: true, subject: true, notAfter: true, certificateType: true },
      }),
    ]);
    const count = (s: VerifactuRecordStatus) => counts.find((c) => c.status === s)?._count ?? 0;
    return {
      available: verifactuAvailable(),
      environment: environment(),
      active: tenant?.fiscalMode === "verifactu",
      pending: count(VerifactuRecordStatus.pending),
      accepted: count(VerifactuRecordStatus.accepted),
      acceptedWithErrors: count(VerifactuRecordStatus.accepted_with_errors),
      rejected: count(VerifactuRecordStatus.rejected),
      incidentSince: chain?.incidentSince ?? null,
      lastError: chain?.lastError ?? null,
      nextSendAt: chain?.nextSendAt ?? null,
      certificate: certificate ?? null,
      platformCertificate: !!process.env.VERIFACTU_PLATFORM_P12,
    };
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
