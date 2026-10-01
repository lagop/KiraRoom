import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import { EmailService } from "../notifications/services/email.service";
import { hashPassword } from "../saas/saas.helpers";

/**
 * Password reset by email, for salon users and for clients.
 *
 * There was none: an owner who forgot their password had no way back in
 * short of writing to support, and a client with a booking account the
 * same. Users had two unused reset columns; clients had nothing.
 *
 * - The link carries a random token; only its sha256 is stored, so a copy
 *   of the database does not hand out working links. It lasts an hour and
 *   works once.
 * - Asking for a reset says nothing about whether the address exists.
 * - A successful reset signs out every session (tokenVersion) and clears
 *   any failed-login lockout.
 */
@Injectable()
export class PasswordResetService {
  static readonly TTL_MS = 60 * 60 * 1000;
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /** Sends a reset link to every account with this email (a client may have one per salon). */
  async request(rawEmail: string, tenantSlug?: string): Promise<void> {
    const email = (rawEmail ?? "").trim();
    if (!email) return;
    const expires = new Date(Date.now() + PasswordResetService.TTL_MS);
    const base = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "");

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" }, isActive: true },
      select: { id: true, email: true, firstName: true },
    });
    if (user) {
      const token = randomBytes(32).toString("hex");
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordResetToken: PasswordResetService.hash(token), passwordResetExpires: expires },
      });
      await this.send(user.email, user.firstName, null, `${base}/reset-password?token=${token}`);
      return;
    }

    const clients = await this.prisma.client.findMany({
      where: {
        email: { equals: email, mode: "insensitive" },
        passwordHash: { not: null },
        status: { not: "blocked" },
        ...(tenantSlug ? { tenant: { slug: tenantSlug } } : {}),
      },
      select: { id: true, email: true, firstName: true, tenant: { select: { name: true } } },
      take: 10,
    });
    for (const client of clients) {
      const token = randomBytes(32).toString("hex");
      await this.prisma.client.update({
        where: { id: client.id },
        data: { passwordResetToken: PasswordResetService.hash(token), passwordResetExpires: expires },
      });
      await this.send(client.email!, client.firstName, client.tenant?.name ?? null, `${base}/reset-password?token=${token}`);
    }
  }

  /** Sets the new password if the token is valid; signs out every session. */
  async reset(token: string, password: string): Promise<void> {
    const invalid = new BadRequestException("El enlace no es válido o ha caducado. Pide uno nuevo.");
    if (!token || token.length < 32) throw invalid;
    if (!password || password.length < 8) {
      throw new BadRequestException("La contraseña debe tener al menos 8 caracteres.");
    }
    const tokenHash = PasswordResetService.hash(token);
    const live = { passwordResetToken: tokenHash, passwordResetExpires: { gt: new Date() } };
    const passwordHash = await hashPassword(password);
    const cleared = {
      passwordHash,
      passwordResetToken: null,
      passwordResetExpires: null,
      tokenVersion: { increment: 1 },
    };

    const user = await this.prisma.user.findFirst({ where: live, select: { id: true } });
    if (user) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { ...cleared, loginAttempts: 0, lockedUntil: null },
      });
      return;
    }
    const client = await this.prisma.client.findFirst({ where: live, select: { id: true } });
    if (client) {
      await this.prisma.client.update({ where: { id: client.id }, data: cleared });
      return;
    }
    throw invalid;
  }

  private async send(to: string, name: string | null, salon: string | null, url: string): Promise<void> {
    try {
      const sent = await this.email.sendPasswordReset({ to, name, salon, resetUrl: url });
      if (!sent.success) this.logger.warn(`password reset email not sent: ${sent.error ?? "unknown"}`);
    } catch (err) {
      this.logger.warn(`password reset email not sent: ${(err as Error).message}`);
    }
  }
}
