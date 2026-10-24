import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EncryptionService } from "../../common/encryption/encryption.service";
import {
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  otpauthUrl,
  verifyCode,
} from "./totp";

export interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
}

/**
 * Two-step sign-in for panel users (owners, staff, the SaaS owner): after the
 * password, a code from an authenticator app, or one of ten recovery codes.
 *
 * Opt-in per user. Turning it on is two steps, so a mistyped QR scan cannot
 * lock anyone out: `setup` keeps a pending secret, and only a correct code
 * from the app (`enable`) makes it the account's. Turning it off needs the
 * password and a code. The secret is stored encrypted, and recovery codes
 * as hashes that are deleted once used.
 *
 * The User table had twoFactorEnabled and twoFactorSecret since its first
 * migration; nothing used them until now.
 */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  private async user(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        twoFactorEnabled: true,
        twoFactorSecret: true,
        twoFactorPendingSecret: true,
        twoFactorLastStep: true,
        twoFactorRecoveryCodes: true,
      },
    });
    if (!user) throw new UnauthorizedException();
    return user;
  }

  async status(userId: string): Promise<TwoFactorStatus> {
    const u = await this.user(userId);
    return { enabled: u.twoFactorEnabled, recoveryCodesLeft: u.twoFactorRecoveryCodes.length };
  }

  /** A new secret for the authenticator app; it counts only after `enable`. */
  async setup(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const u = await this.user(userId);
    if (u.twoFactorEnabled) throw new ConflictException("La verificación en dos pasos ya está activada.");
    const secret = generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorPendingSecret: this.encryption.encrypt(secret) },
    });
    return { secret, otpauthUrl: otpauthUrl(secret, u.email) };
  }

  /** Confirms the app with its first code; returns the recovery codes, shown once. */
  async enable(userId: string, code: string, now = new Date()): Promise<{ recoveryCodes: string[] }> {
    const u = await this.user(userId);
    if (u.twoFactorEnabled) throw new ConflictException("La verificación en dos pasos ya está activada.");
    if (!u.twoFactorPendingSecret) throw new BadRequestException("Empieza de nuevo: escanea el código QR.");
    const secret = this.encryption.decrypt(u.twoFactorPendingSecret);
    const step = verifyCode(secret, code, now);
    if (step === null) throw new BadRequestException("El código no es correcto. Prueba con el que muestra ahora la app.");

    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorSecret: u.twoFactorPendingSecret,
        twoFactorPendingSecret: null,
        twoFactorLastStep: step,
        twoFactorRecoveryCodes: recoveryCodes.map(hashRecoveryCode),
      },
    });
    return { recoveryCodes };
  }

  /**
   * Off again: the password and a current code (or a recovery code). A wrong
   * one is a 400, not a 401: the panel reads any 401 as an expired session
   * and would sign the user out.
   */
  async disable(userId: string, password: string, code: string, now = new Date()): Promise<TwoFactorStatus> {
    const u = await this.user(userId);
    if (!u.twoFactorEnabled) return { enabled: false, recoveryCodesLeft: 0 };
    if (!(await bcrypt.compare(password ?? "", u.passwordHash))) {
      throw new BadRequestException("La contraseña no es correcta.");
    }
    if (!(await this.verifyForLogin(userId, code, now))) {
      throw new BadRequestException("El código no es correcto.");
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorPendingSecret: null,
        twoFactorLastStep: null,
        twoFactorRecoveryCodes: [],
      },
    });
    return { enabled: false, recoveryCodesLeft: 0 };
  }

  /** Ten fresh recovery codes, replacing the old ones; needs a current code. */
  async regenerateRecoveryCodes(userId: string, code: string, now = new Date()): Promise<{ recoveryCodes: string[] }> {
    const u = await this.user(userId);
    if (!u.twoFactorEnabled) throw new BadRequestException("La verificación en dos pasos no está activada.");
    if (!(await this.verifyForLogin(userId, code, now))) {
      throw new BadRequestException("El código no es correcto.");
    }
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorRecoveryCodes: recoveryCodes.map(hashRecoveryCode) },
    });
    return { recoveryCodes };
  }

  /**
   * Whether `code` is the app's current code or an unused recovery code. A
   * code that matches is spent: the step is remembered, the recovery code
   * deleted. The update is conditional on what was read, so two requests
   * with the same code cannot both pass.
   */
  async verifyForLogin(userId: string, code: string, now = new Date()): Promise<boolean> {
    const u = await this.user(userId);
    if (!u.twoFactorEnabled || !u.twoFactorSecret || typeof code !== "string") return false;

    const step = verifyCode(this.encryption.decrypt(u.twoFactorSecret), code, now, u.twoFactorLastStep);
    if (step !== null) {
      const { count } = await this.prisma.user.updateMany({
        where: { id: userId, twoFactorLastStep: u.twoFactorLastStep },
        data: { twoFactorLastStep: step },
      });
      return count === 1;
    }

    const hash = hashRecoveryCode(code);
    if (!u.twoFactorRecoveryCodes.includes(hash)) return false;
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, twoFactorRecoveryCodes: { has: hash } },
      data: { twoFactorRecoveryCodes: u.twoFactorRecoveryCodes.filter((h) => h !== hash) },
    });
    return count === 1;
  }
}
