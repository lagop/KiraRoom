import { Controller, Get, Module, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  parseAllowedOrigins,
  buildCorsOptions,
  corsRejectionHandler,
  CorsOriginNotAllowedError,
  DEFAULT_DEV_ORIGIN,
} from './cors';

const ALLOWED = 'https://app.kiraroom.net';
const DISALLOWED = 'https://evil.example.com';

@Controller()
class PingController {
  @Get('ping')
  ping(): string {
    return 'pong';
  }
}

@Module({ controllers: [PingController] })
class TestModule {}

/**
 * Boots a real Nest app with the production CORS wiring.
 *
 * The status code could not be settled by reading the code: the `cors`
 * middleware runs before Nest's router, so it was not obvious whether a
 * rejection would reach a Nest exception filter (it does not) or what
 * Express would answer. These cases pin the behaviour end to end.
 */
async function bootApp(origins: string[]): Promise<INestApplication> {
  const app = await NestFactory.create(TestModule, { logger: false });
  const silent = { warn: () => undefined } as unknown as Logger;
  app.enableCors(buildCorsOptions(origins, silent));
  app.use(corsRejectionHandler);
  await app.init();
  return app;
}

describe('CORS allow-list', () => {
  describe('parseAllowedOrigins', () => {
    it('prefers CORS_ALLOWED_ORIGINS and splits on commas', () => {
      expect(
        parseAllowedOrigins({
          CORS_ALLOWED_ORIGINS: 'https://a.test, https://b.test',
          FRONTEND_URL: 'https://ignored.test',
        } as NodeJS.ProcessEnv),
      ).toEqual(['https://a.test', 'https://b.test']);
    });

    it('falls back to FRONTEND_URL, then to the dev default', () => {
      expect(
        parseAllowedOrigins({ FRONTEND_URL: 'https://b.test' } as NodeJS.ProcessEnv),
      ).toEqual(['https://b.test']);
      expect(parseAllowedOrigins({} as NodeJS.ProcessEnv)).toEqual([DEFAULT_DEV_ORIGIN]);
    });

    it('drops empty entries from a trailing comma', () => {
      expect(
        parseAllowedOrigins({
          CORS_ALLOWED_ORIGINS: 'https://a.test,,  ,',
        } as NodeJS.ProcessEnv),
      ).toEqual(['https://a.test']);
    });
  });

  describe('served responses', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootApp([ALLOWED]);
    });

    afterAll(async () => {
      await app.close();
    });

    it('answers 403, not 500, for a disallowed origin', async () => {
      // The regression this exists for. A plain Error here reached
      // Express's default handler and answered 500, which reads as
      // "the API is broken" in logs and uptime checks.
      const res = await request(app.getHttpServer())
        .get('/ping')
        .set('Origin', DISALLOWED);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        statusCode: 403,
        message: 'Origin not allowed by CORS policy',
        error: 'Forbidden',
      });
    });

    it('answers 403 on the preflight too', async () => {
      const res = await request(app.getHttpServer())
        .options('/ping')
        .set('Origin', DISALLOWED)
        .set('Access-Control-Request-Method', 'POST');

      expect(res.status).toBe(403);
    });

    it('allows a listed origin and echoes it back', async () => {
      const res = await request(app.getHttpServer())
        .get('/ping')
        .set('Origin', ALLOWED);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('allows a request with no Origin header at all', async () => {
      // Health probes and server-to-server calls. The container's own
      // healthcheck is one of these.
      const res = await request(app.getHttpServer()).get('/ping');

      expect(res.status).toBe(200);
    });
  });

  describe('wildcard', () => {
    it('warns once at startup rather than once per request', () => {
      const warn = jest.fn();
      buildCorsOptions(['*'], { warn } as unknown as Logger);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('allowing all origins'));
    });

    it('accepts any origin when configured with *', async () => {
      const app = await bootApp(['*']);
      const res = await request(app.getHttpServer())
        .get('/ping')
        .set('Origin', DISALLOWED);

      expect(res.status).toBe(200);
      await app.close();
    });
  });

  describe('corsRejectionHandler', () => {
    it('passes any other error along untouched', () => {
      const next = jest.fn();
      const res = { status: jest.fn(), json: jest.fn() };
      const other = new Error('something else');

      corsRejectionHandler(other, {} as never, res as never, next);

      expect(next).toHaveBeenCalledWith(other);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('carries the rejected origin on the error for logging', () => {
      const err = new CorsOriginNotAllowedError(DISALLOWED);

      expect(err.origin).toBe(DISALLOWED);
      expect(err.message).toContain(DISALLOWED);
    });
  });
});
