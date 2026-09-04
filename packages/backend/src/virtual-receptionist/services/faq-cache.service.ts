import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/cache/redis.service';
import { FAQService } from './faq.service';
import { FAQItem } from '@kira/shared';
import { MetricsService, COUNTERS } from '../../common/observability/metrics.service';

/**
 * Redis-backed wrapper around {@link FAQService.findFAQMatch}. Caches
 * the best-match result keyed by `tenantId + normalized question` with
 * a 24-hour TTL so the in-memory keyword scan is only run for new
 * messages.
 *
 * Importantly, this caches the **query result** (which FAQ matched)
 * and not the LLM response — see the orchestrator for the LLM-skip
 * path that turns an FAQ hit into a direct, no-LLM answer.
 */
@Injectable()
export class FAQCacheService {
  private readonly logger = new Logger(FAQCacheService.name);
  // Cheap counts for observability logs; no Prometheus to keep this
  // self-contained.
  private hits = 0;
  private misses = 0;
  private storeFailures = 0;
  private static readonly TTL_SECONDS = 24 * 60 * 60;

  constructor(
    private readonly faqService: FAQService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Same signature as FAQService.findFAQMatch but reads/writes through
   * Redis. The cached value is the JSON-serialised FAQ item (or
   * `{__miss:true}` for negative caching, which still saves the
   * keyword scan).
   */
  async findMatch(salonId: string, analysis: any): Promise<FAQItem | null> {
    const normalized = normalizeForCacheKey(analysis);
    const key = buildCacheKey(salonId, normalized);

    try {
      const cached = await this.redis.get(key);
      if (cached !== null) {
        if (cached === MISS_MARKER) {
          this.hits++;
          this.metrics.counter(COUNTERS.FAQ_CACHE_HIT, 'FAQ cache hit (negative cache counts as a hit — saved a Redis+keyword round-trip)').inc();
          return null;
        }
        this.hits++;
        this.metrics.counter(COUNTERS.FAQ_CACHE_HIT, 'FAQ cache hit (negative cache counts as a hit — saved a Redis+keyword round-trip)').inc();
        return JSON.parse(cached) as FAQItem;
      }
    } catch (err) {
      this.logger.warn(
        `Cache read failed for ${key}: ${(err as Error).message}`,
      );
    }

    this.misses++;
    this.metrics.counter(COUNTERS.FAQ_CACHE_MISS, 'FAQ cache miss — keyword scan ran').inc();
    const faq = await this.faqService.findFAQMatch(salonId, analysis);
    try {
      await this.redis.set(
        key,
        faq ? JSON.stringify(faq) : MISS_MARKER,
        FAQCacheService.TTL_SECONDS,
      );
    } catch (err) {
      this.storeFailures++;
      this.logger.warn(
        `Cache write failed for ${key}: ${(err as Error).message}`,
      );
    }
    return faq;
  }

  /**
   * Bust the cache for a single tenant. Call this when an admin
   * updates the FAQ list so the next user request rebuilds.
   */
  async invalidateTenant(salonId: string): Promise<void> {
    // Use SCAN-style pattern: we don't track keys so we namespace by
    // a tenant prefix and rely on TTL for the rest.
    try {
      await this.redis.del(buildCacheKey(salonId, '*'));
    } catch {
      /* swallow */
    }
  }

  getStats() {
    return {
      hits: this.hits,
      misses: this.misses,
      storeFailures: this.storeFailures,
      hitRate:
        this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
      usingFallback: this.redis.isUsingFallback(),
    };
  }
}

const MISS_MARKER = '__faq_miss__';

function normalizeForCacheKey(analysis: any): string {
  // Use only stable, intent-derived signals. Don't include the raw
  // user message verbatim: paraphrases of the same question have
  // different surface forms but should hit the same cache entry.
  const intents: string[] = [];
  if (analysis?.intent) intents.push(String(analysis.intent));
  if (Array.isArray(analysis?.keywords)) {
    intents.push(
      [...analysis.keywords]
        .map((w: any) => String(w).toLowerCase().trim())
        .filter((w: string) => w.length > 1)
        .sort()
        .join(','),
    );
  }
  return intents.join('|');
}

function buildCacheKey(salonId: string, normalized: string): string {
  // Keep keys short; hash if they get long.
  const trimmedSalonId = salonId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const safe = normalized.length > 200 ? normalized.slice(0, 200) : normalized;
  return `vrm:faq:${trimmedSalonId}:${safe}`;
}
