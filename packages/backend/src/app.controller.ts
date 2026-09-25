import { Controller, Get } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from './auth/decorators/public.decorator';

/**
 * Liveness endpoints.
 *
 * These MUST be `@Public()`. `JwtAuthGuard` is a global APP_GUARD, so without
 * it `/api/v1/ping` answered 401 -- and the container healthcheck in
 * docker-compose.prod.yml is `wget --spider -q http://localhost:3001/api/v1/ping`,
 * which treats 401 as failure. The result was a backend that ran fine but was
 * permanently marked `unhealthy`, and Traefik's Docker provider skips unhealthy
 * containers: it never registered the router for `api.kiraroom.net`, answered
 * with its default self-signed certificate, and every call from the frontend
 * died with ERR_CERT_AUTHORITY_INVALID. The API was unreachable in production
 * for three days while the container itself was healthy in every sense that
 * mattered.
 *
 * The frontend never hit this because its healthcheck probes the Next.js root,
 * which needs no auth. That asymmetry is what made it look like a TLS problem.
 */
@ApiTags('health')
@Controller()
export class AppController {
  @Get()
  @Public()
  @ApiOperation({ summary: 'Health check' })
  @ApiResponse({ status: 200, description: 'API is healthy' })
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'Kira Room Backend',
      version: '1.0.0' };
  }

  @Get('ping')
  @Public()
  @ApiOperation({ summary: 'Simple ping' })
  ping() {
    return 'pong';
  }
}
