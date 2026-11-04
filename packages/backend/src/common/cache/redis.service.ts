import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';

/**
 * Thin wrapper around `node-redis` v4 with a graceful in-memory
 * fallback for local dev (no Redis) and transient outages.
 *
 * Keys are plain strings. Values are JSON-serialised (so callers must
 * handle their own JSON round-trip — we don't try to be clever about
 * types because the cache always stores structured results anyway).
 *
 * `REDIS_URL` (or `REDIS_HOST` + `REDIS_PORT`) drives the connection.
 * Set either in `.env`. If neither is reachable, the service silently
 * switches to a `Map`-backed fallback so the app keeps working —
 * cache misses become the norm but the rest of the app is unaffected.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: RedisClientType | null = null;
  private fallback = new Map<string, { value: string; expiresAt: number | null }>();
  private usingFallback = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const url =
      this.configService.get<string>('REDIS_URL') ||
      (this.configService.get<string>('REDIS_HOST')
        ? `redis://${this.configService.get<string>('REDIS_HOST')}:${this.configService.get<number>('REDIS_PORT') ?? 6379}`
        : null);

    if (!url) {
      this.logger.warn(
        'No REDIS_URL / REDIS_HOST configured — FAQ cache will use in-memory fallback (per-instance, not shared).',
      );
      this.usingFallback = true;
      return;
    }

    try {
      this.client = createClient({ url }) as RedisClientType;
      this.client.on('error', (err) => {
        this.logger.error(`Redis error: ${err.message}`);
      });
      await this.client.connect();
      this.logger.log(`Redis client connected to ${this.maskUrl(url)}`);
    } catch (err) {
      this.logger.warn(
        `Could not connect to Redis at ${this.maskUrl(url)}: ${(err as Error).message}. Falling back to in-memory cache.`,
      );
      this.client = null;
      this.usingFallback = true;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        /* ignore */
      }
    }
  }

  isUsingFallback(): boolean {
    return this.usingFallback;
  }

  async get(key: string): Promise<string | null> {
    if (this.usingFallback) return this.fallbackGet(key);
    return this.client!.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.usingFallback) {
      this.fallbackSet(key, value, ttlSeconds);
      return;
    }
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client!.set(key, value, { EX: ttlSeconds });
    } else {
      await this.client!.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    if (this.usingFallback) {
      this.fallback.delete(key);
      return;
    }
    await this.client!.del(key);
  }

  /**
   * SET key value NX EX ttl: true when the key was not there and is now
   * set (the first to claim it), false when it already existed. Used to
   * handle a webhook delivery once across restarts and instances. If Redis
   * fails at that moment the in-memory map answers, so a message is still
   * handled (at most once per instance) rather than dropped.
   */
  async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!this.usingFallback && this.client) {
      try {
        const res = await this.client.set(key, value, { NX: true, EX: ttlSeconds });
        return res === 'OK';
      } catch (err) {
        this.logger.warn(`Redis SET NX failed, using the in-memory fallback: ${(err as Error).message}`);
      }
    }
    if (this.fallbackGet(key) !== null) return false;
    this.fallbackSet(key, value, ttlSeconds);
    return true;
  }

  /**
   * INCR, with the expiry set on the first increment: a counter for a fixed
   * window (messages per sender and hour). Same fallback as setIfAbsent.
   */
  async increment(key: string, ttlSeconds: number): Promise<number> {
    if (!this.usingFallback && this.client) {
      try {
        const n = await this.client.incr(key);
        if (n === 1) await this.client.expire(key, ttlSeconds);
        return n;
      } catch (err) {
        this.logger.warn(`Redis INCR failed, using the in-memory fallback: ${(err as Error).message}`);
      }
    }
    const current = Number(this.fallbackGet(key) ?? 0) + 1;
    const entry = this.fallback.get(key);
    if (entry && current > 1) entry.value = String(current);
    else this.fallbackSet(key, String(current), ttlSeconds);
    return current;
  }

  private fallbackGet(key: string): string | null {
    const entry = this.fallback.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.fallback.delete(key);
      return null;
    }
    return entry.value;
  }

  private fallbackSet(key: string, value: string, ttlSeconds?: number): void {
    const expiresAt =
      ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    // Expired entries are only dropped when read: sweep them now and then,
    // so per-message keys do not pile up for the life of the process.
    if (this.fallback.size > 10_000) {
      const now = Date.now();
      for (const [k, e] of this.fallback) if (e.expiresAt !== null && now > e.expiresAt) this.fallback.delete(k);
    }
    this.fallback.set(key, { value, expiresAt });
  }

  private maskUrl(url: string): string {
    try {
      const u = new URL(url);
      if (u.password) u.password = '***';
      return u.toString();
    } catch {
      return url.replace(/(:[^:@/]+@)/, ':***@');
    }
  }
}
