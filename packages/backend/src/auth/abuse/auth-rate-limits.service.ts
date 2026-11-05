import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { RedisService } from "../../common/cache/redis.service";
import { COMMON_EMAIL_PROVIDERS, emailDomain } from "./disposable-email-domains";

const HOUR = 3600;

/** Per-window allowances. Exported for the specs and the PR description. */
export const AUTH_LIMITS = {
  /** Signups from one address in an hour (the route's in-memory throttle says the same). */
  signupsPerIpPerHour: 5,
  /** Signups with a big consumer provider's domain (gmail.com...) in an hour, platform-wide. */
  signupsPerCommonDomainPerHour: 60,
  /** Signups with any other domain in an hour. */
  signupsPerOtherDomainPerHour: 3,
  /** Reset emails to one address in an hour. */
  passwordResetsPerEmailPerHour: 3,
  /** Verification emails one account can ask for in an hour. */
  verificationResendsPerUserPerHour: 3,
  /** Failed sign-ins for one email before the captcha is asked for. */
  loginFailuresBeforeCaptcha: 3,
  /** Failed sign-ins from one address before the captcha is asked for. */
  loginFailuresPerIpBeforeCaptcha: 10,
  /** How long failed sign-ins are remembered. */
  loginFailureWindowSeconds: HOUR,
  /** Wrong passwords for the platform owner from one address before that address is locked out (C12). */
  platformOwnerFailuresPerIp: 5,
  /** How long that address stays locked out of the platform owner account. */
  platformOwnerLockSeconds: 30 * 60,
} as const;

/** Emails and IPs go into Redis keys hashed, not in clear. */
function keyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * Counters for the signup and sign-in routes, in Redis so they hold across
 * deploys and (one day) several API instances. The route throttles
 * (@Throttle) count per IP in this process's memory and reset on every
 * deploy; these do not. RedisService falls back to memory when Redis is
 * down, so a Redis outage weakens the limits but never blocks a signup.
 */
@Injectable()
export class AuthRateLimitsService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Counts one signup attempt from this IP and email domain. Returns which
   * limit it went over, or null when it is within both.
   */
  async signupAttempt(ip: string | null | undefined, email: string): Promise<"ip" | "domain" | null> {
    const domain = emailDomain(email);
    const ipCount = ip ? await this.redis.increment(`auth:signup:ip:${keyPart(ip)}`, HOUR) : 0;
    const domainCount = domain ? await this.redis.increment(`auth:signup:domain:${keyPart(domain)}`, HOUR) : 0;
    if (ipCount > AUTH_LIMITS.signupsPerIpPerHour) return "ip";
    const domainLimit = COMMON_EMAIL_PROVIDERS.has(domain)
      ? AUTH_LIMITS.signupsPerCommonDomainPerHour
      : AUTH_LIMITS.signupsPerOtherDomainPerHour;
    if (domainCount > domainLimit) return "domain";
    return null;
  }

  /** Counts one reset email to this address; false once over the hourly limit. */
  async allowPasswordResetEmail(email: string): Promise<boolean> {
    const n = await this.redis.increment(`auth:reset:email:${keyPart(email)}`, HOUR);
    return n <= AUTH_LIMITS.passwordResetsPerEmailPerHour;
  }

  /** Counts one verification resend for this account; false once over the hourly limit. */
  async allowVerificationResend(userId: string): Promise<boolean> {
    const n = await this.redis.increment(`auth:verify-resend:user:${userId}`, HOUR);
    return n <= AUTH_LIMITS.verificationResendsPerUserPerHour;
  }

  /** Whether the next sign-in for this email (or from this IP) must pass the captcha. */
  async loginNeedsCaptcha(email: string, ip: string | null | undefined): Promise<boolean> {
    const byEmail = Number((await this.redis.get(this.loginEmailKey(email))) ?? 0);
    if (byEmail >= AUTH_LIMITS.loginFailuresBeforeCaptcha) return true;
    if (!ip) return false;
    const byIp = Number((await this.redis.get(this.loginIpKey(ip))) ?? 0);
    return byIp >= AUTH_LIMITS.loginFailuresPerIpBeforeCaptcha;
  }

  /** Records a failed sign-in; answers whether the next one needs the captcha. */
  async loginFailed(email: string, ip: string | null | undefined): Promise<boolean> {
    const ttl = AUTH_LIMITS.loginFailureWindowSeconds;
    const byEmail = await this.redis.increment(this.loginEmailKey(email), ttl);
    const byIp = ip ? await this.redis.increment(this.loginIpKey(ip), ttl) : 0;
    return (
      byEmail >= AUTH_LIMITS.loginFailuresBeforeCaptcha || byIp >= AUTH_LIMITS.loginFailuresPerIpBeforeCaptcha
    );
  }

  /** A successful sign-in clears the email's failures (the IP's age out). */
  async loginSucceeded(email: string): Promise<void> {
    await this.redis.del(this.loginEmailKey(email));
  }

  /**
   * Audit 8, C12: the platform owner (saas_owner) is not locked account-wide
   * by wrong passwords, or anyone who knows the address could keep the
   * console shut. The lock is per address instead: 5 wrong passwords from
   * one IP lock that IP out of the account for 30 minutes, and the owner
   * still gets in from anywhere else. The captcha after 3 failures and the
   * route throttle apply as for everyone.
   */
  async platformOwnerLockedFrom(userId: string, ip: string | null | undefined): Promise<boolean> {
    const n = Number((await this.redis.get(this.ownerIpKey(userId, ip))) ?? 0);
    return n >= AUTH_LIMITS.platformOwnerFailuresPerIp;
  }

  async platformOwnerFailedFrom(userId: string, ip: string | null | undefined): Promise<void> {
    await this.redis.increment(this.ownerIpKey(userId, ip), AUTH_LIMITS.platformOwnerLockSeconds);
  }

  async platformOwnerSignedInFrom(userId: string, ip: string | null | undefined): Promise<void> {
    await this.redis.del(this.ownerIpKey(userId, ip));
  }

  private ownerIpKey(userId: string, ip: string | null | undefined): string {
    return `auth:owner-fail:${userId}:${keyPart(ip || "unknown")}`;
  }

  private loginEmailKey(email: string): string {
    return `auth:login-fail:email:${keyPart(email)}`;
  }

  private loginIpKey(ip: string): string {
    return `auth:login-fail:ip:${keyPart(ip)}`;
  }
}
