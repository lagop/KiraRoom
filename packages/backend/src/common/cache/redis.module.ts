import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Global cache module. The {@link RedisService} is intentionally
 * mark as `@Global()` so the FAQ cache, future rate-limiters, and any
 * other module can inject it without a per-feature import.
 *
 * If Redis is not reachable at startup, the service degrades to an
 * in-memory map and logs a warning. The rest of the app keeps working.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
