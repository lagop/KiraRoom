import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { UserRole } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { AuditLogService } from "../saas/audit-log.service";
import { RETENTION_FLAG, retentionEnabled } from "../saas/retention/salon-retention";

/** What the console shows. */
export interface PlatformRetentionConfigPublic {
  /** What the console switch says (off until the saas_owner turns it on). */
  enabled: boolean;
  /** RETENTION_ANONYMIZE_ENABLED=true on the server: it turns the job on whatever the switch says. */
  envOverride: boolean;
  /** Whether the job acts for real (switch on or env override); otherwise it is a dry run. */
  effective: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface Actor {
  id: string;
  role: string;
}

/**
 * Whether the retention job (saas/retention/salon-retention.scheduler.ts) and
 * the weekly digest treat retention as on. The console's switch, or the
 * server's RETENTION_ANONYMIZE_ENABLED=true (kept as an override so a server
 * that already relies on it keeps working; the console cannot turn it off).
 */
export function retentionEffective(envValue: string | undefined | null, stored: boolean): boolean {
  return retentionEnabled(envValue) || stored;
}

/**
 * The retention switch of the platform (PlatformRetentionConfig), for the
 * saas_owner in the console. Off by default: a dry run that only lists what
 * it would do. On: salons whose trial or subscription ended more than 60
 * days ago are anonymised for real (invoices kept) after their owner is
 * warned by email 7 days before. That is irreversible, so changing it needs
 * two-step sign-in, like the other platform settings, and is audited.
 *
 * Read from the database on every use (the job runs once a day and the
 * digest weekly), so a change applies to the next run with no restart.
 */
@Injectable()
export class PlatformRetentionConfigService {
  private readonly logger = new Logger(PlatformRetentionConfigService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly auditLog: AuditLogService,
  ) {}

  private envOverride(): boolean {
    return retentionEnabled(this.config.get<string>(RETENTION_FLAG));
  }

  /** True when the job should act for real: the console switch is on, or the env override is. */
  async isEnabled(): Promise<boolean> {
    if (this.envOverride()) return true;
    const row = await this.prisma.platformRetentionConfig.findUnique({ where: { id: "global" }, select: { enabled: true } });
    return retentionEffective(undefined, row?.enabled ?? false);
  }

  async getConfig(): Promise<PlatformRetentionConfigPublic> {
    const row = await this.prisma.platformRetentionConfig.findUnique({ where: { id: "global" } });
    const enabled = row?.enabled ?? false;
    const envOverride = this.envOverride();
    return {
      enabled,
      envOverride,
      effective: envOverride || enabled,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  async update(input: { enabled: boolean }, actor: Actor): Promise<PlatformRetentionConfigPublic> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { twoFactorEnabled: true, email: true },
    });
    if (!user?.twoFactorEnabled) {
      throw new ForbiddenException(
        "Para cambiar la retención de datos, activa antes la verificación en dos pasos en Seguridad.",
      );
    }

    const before = await this.prisma.platformRetentionConfig.findUnique({ where: { id: "global" }, select: { enabled: true } });
    await this.prisma.platformRetentionConfig.upsert({
      where: { id: "global" },
      create: { id: "global", enabled: input.enabled, updatedBy: user.email },
      update: { enabled: input.enabled, updatedBy: user.email },
    });
    await this.auditLog.record("platform.retention_config.updated", {
      actorId: actor.id,
      actorRole: actor.role as UserRole,
      metadata: { enabled: input.enabled, previous: before?.enabled ?? false, envOverride: this.envOverride() },
    });
    this.logger.warn(`Platform retention switched ${input.enabled ? "ON" : "OFF"} by ${actor.id}`);
    return this.getConfig();
  }
}
