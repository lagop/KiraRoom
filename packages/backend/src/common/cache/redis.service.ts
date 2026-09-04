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
