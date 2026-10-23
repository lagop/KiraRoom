import { randomUUID } from "crypto";
import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../../common/prisma/prisma.service";

/**
 * How long the refresh token a rotation replaced keeps working, and only to
 * get an access token (no new refresh token). Two tabs share the cookie and
 * may refresh at the same moment: the first rotates it, the second arrives
 * with the old one a few milliseconds later and must not be taken for a
 * stolen copy.
 */
export const ROTATION_GRACE_MS = 60_000;

/** Keep ended sessions this long before deleting them, for diagnosis. */
const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

export type SessionSubject = { id: string; type: "user" | "client" };

export type RotationOutcome =
  /** Issue a new refresh token carrying this jti. */
  | { kind: "rotated"; jti: string }
  /** The previous token, inside the grace window: an access token only. */
  | { kind: "grace" };

/**
 * Refresh-token rotation. Each signed-in browser or device is one
 * AuthSession; its refresh token carries the session id (`sid`) and the
 * current rotation (`jti`). A refresh swaps the jti, so a refresh token works
 * once. If a replaced one comes back after the grace window, someone kept a
 * copy: the session is revoked and both the thief and the owner must sign in
 * again (the owner's next refresh fails too, which is the point).
 *
 * Logging out and changing the password still end every session through
 * `tokenVersion`; this table adds per-session rotation on top.
 */
@Injectable()
export class AuthSessionsService {
  private readonly logger = new Logger(AuthSessionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async start(subject: SessionSubject, expiresAt: Date): Promise<{ sid: string; jti: string }> {
    const jti = randomUUID();
    const session = await this.prisma.authSession.create({
      data: { subjectId: subject.id, subjectType: subject.type, currentJti: jti, expiresAt },
      select: { id: true },
    });
    return { sid: session.id, jti };
  }

  async rotate(sid: string, jti: string, expiresAt: Date, now = new Date()): Promise<RotationOutcome> {
    const next = randomUUID();
    // Conditional on the jti, so of two simultaneous refreshes exactly one
    // rotates; the other finds its jti as previousJti and gets the grace path.
    const { count } = await this.prisma.authSession.updateMany({
      where: { id: sid, currentJti: jti, revokedAt: null, expiresAt: { gt: now } },
      data: { previousJti: jti, currentJti: next, rotatedAt: now, expiresAt },
    });
    if (count === 1) return { kind: "rotated", jti: next };

    const session = await this.prisma.authSession.findUnique({ where: { id: sid } });
    if (!session || session.revokedAt || session.expiresAt <= now) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    if (
      session.previousJti === jti &&
      session.rotatedAt &&
      now.getTime() - session.rotatedAt.getTime() <= ROTATION_GRACE_MS
    ) {
      return { kind: "grace" };
    }

    await this.prisma.authSession.update({ where: { id: sid }, data: { revokedAt: now } });
    this.logger.warn(
      `Refresh token reused for session ${sid} (${session.subjectType} ${session.subjectId}): session revoked`,
    );
    throw new UnauthorizedException("Invalid refresh token");
  }

  async revoke(sid: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id: sid, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeEnded(now = new Date()): Promise<void> {
    const before = new Date(now.getTime() - PURGE_AFTER_MS);
    const { count } = await this.prisma.authSession.deleteMany({
      where: { OR: [{ expiresAt: { lt: before } }, { revokedAt: { lt: before } }] },
    });
    if (count > 0) this.logger.log(`Deleted ${count} ended session(s)`);
  }
}
