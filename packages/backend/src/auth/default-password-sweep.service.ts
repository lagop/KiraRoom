import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../common/prisma/prisma.service";
import { AuditLogService } from "../saas/audit-log.service";
import { hashPassword } from "../saas/saas.helpers";
import { unusablePassword } from "../saas/saas.service";
import { PasswordResetService } from "./password-reset.service";
import { sessionRevocations } from "./sessions/session-revocations";

/** The marker row in maintenance_tasks. */
export const DEFAULT_PASSWORD_SWEEP_TASK = "default-password-sweep-2026-11";

/** Users checked per query; bcrypt is slow, so batches stay small. */
export const SWEEP_BATCH_SIZE = 50;

/** Wait after boot before starting, so the sweep never delays startup. */
const START_DELAY_MS = 30_000;

/**
 * The password the console used to give an owner created without one (audit
 * 8 C1, removed in #273). It was published in this public repo, so it is put
 * together here instead of written out.
 */
export function oldConsoleDefaultPassword(): string {
  return ["Change", "Me", String(123), "!"].join("");
}

/**
 * One-time sweep, after boot: any user whose password is still the old
 * console default gets a random password nobody knows, loses every session
 * (tokenVersion) and is sent the password-reset email to choose a new one.
 *
 * - Runs once: a maintenance_tasks row marks it done. A run cut short simply
 *   runs again on the next boot; users already reset no longer match.
 * - Never blocks startup: it starts a while after boot, without being
 *   awaited, and checks the users in small batches (bcryptjs compares yield
 *   to the event loop).
 * - Logs only counts. Each reset is audit-logged with the user id alone.
 */
@Injectable()
export class DefaultPasswordSweepService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DefaultPasswordSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordReset: PasswordResetService,
    private readonly auditLog: AuditLogService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test" || process.env.DISABLE_DEFAULT_PASSWORD_SWEEP === "true") return;
    const timer = setTimeout(() => {
      this.run().catch((err) => this.logger.warn(`default password sweep failed: ${(err as Error).message}`));
    }, START_DELAY_MS);
    timer.unref?.();
  }

  /** Runs the sweep unless it already finished. Returns the counts (null when skipped). */
  async run(): Promise<{ checked: number; reset: number } | null> {
    const done = await this.prisma.maintenanceTask.findUnique({ where: { name: DEFAULT_PASSWORD_SWEEP_TASK } });
    if (done) return null;

    const old = oldConsoleDefaultPassword();
    let checked = 0;
    let reset = 0;
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.user.findMany({
        where: { passwordHash: { not: "" } },
        select: { id: true, email: true, tenantId: true, passwordHash: true },
        orderBy: { id: "asc" },
        take: SWEEP_BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;

      for (const user of batch) {
        checked++;
        let matches = false;
        try {
          matches = !!user.passwordHash && (await bcrypt.compare(old, user.passwordHash));
        } catch {
          matches = false; // not a bcrypt hash
        }
        if (!matches) continue;
        await this.resetUser(user);
        reset++;
      }
      // Let other work run between batches.
      await new Promise((resolve) => setImmediate(resolve));
    }

    await this.prisma.maintenanceTask.create({
      data: { name: DEFAULT_PASSWORD_SWEEP_TASK, result: { checked, reset } },
    });
    this.logger.log(`default password sweep done: ${checked} users checked, ${reset} reset`);
    return { checked, reset };
  }

  private async resetUser(user: { id: string; email: string; tenantId: string | null }): Promise<void> {
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(unusablePassword()),
        tokenVersion: { increment: 1 },
        passwordResetToken: null,
        passwordResetExpires: null,
      },
    });
    sessionRevocations.revoke({ userId: user.id });
    try {
      await this.auditLog.record("user.default_password.reset", {
        actorId: "system:default-password-sweep",
        actorRole: UserRole.saas_owner,
        tenantId: user.tenantId ?? undefined,
        metadata: { userId: user.id },
      });
    } catch (err) {
      this.logger.warn(`default password sweep: audit log failed: ${(err as Error).message}`);
    }
    // The same email and link as a console-created owner without a password.
    try {
      await this.passwordReset.request(user.email);
    } catch (err) {
      this.logger.warn(`default password sweep: reset email not sent: ${(err as Error).message}`);
    }
  }
}
