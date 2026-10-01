import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * The global rate limit, counted per client address.
 *
 * This class used to be empty -- `export class ThrottlerBehindProxyGuard {}`
 * -- so although ThrottlerModule was configured and a dozen routes carried
 * @Throttle, nothing was ever limited: logins could be guessed, the public
 * booking form filled with fake appointments and the receptionist chat run
 * up the AI bill without a brake.
 *
 * The address is `req.ip`, which Express derives from X-Forwarded-For only
 * for the proxies listed in TRUSTED_PROXIES (Traefik, on the Docker network).
 * Counters live in this process's memory: right for the single API
 * instance there is today; a second instance would need a shared store.
 */
@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}
