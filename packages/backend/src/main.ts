// Must stay the first import: Sentry has to be initialised before Nest,
// Express and the HTTP modules load so their integrations can hook in.
import "./instrument";
import { Logger } from "@nestjs/common";
import { createGlobalValidationPipe } from "./common/validation/global-validation-pipe";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { json, urlencoded } from "express";
import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { applyHttpHardening, swaggerEnabled } from "./common/http-hardening";
import {
  validateJwtSecretOrExit,
  validateJwtRefreshSecretOrExit,
  validateStripeWebhookConfigOrExit,
  validateOAuthStateSecretOrExit,
} from "./startup-checks";
import {
  parseAllowedOrigins,
  buildCorsOptions,
  corsRejectionHandler,
  salonOriginAllowed,
} from "./common/cors";
import { WebDomainService } from "./web-domain/web-domain.service";


/**
 * SEC-1 (P2A-staff-copilot GA): JWT secret strength check at startup.
 *
 * Implementation lives in `startup-checks.ts` (extracted to keep these
 * checks pure and trivially testable without importing AppModule).
 *
 * SEC-3: Stripe webhook signature configuration check at startup.
 *   Same file. See `startup-checks.ts` for the full rationale.
 */

async function bootstrap(): Promise<void> {

  // SEC-1: fail fast on a missing or weak JWT secret. Tests can opt
  // out via ALLOW_WEAK_JWT_SECRET=1.
  validateJwtSecretOrExit();

  // SEC-7: refuse to boot in production without a distinct
  // JWT_REFRESH_SECRET. Unset, @nestjs/jwt signs refresh tokens with
  // JWT_SECRET, which makes every access token a valid refresh token.
  validateJwtRefreshSecretOrExit();

  // SEC-3: refuse to boot if Stripe is half-configured (secret key set,
  // webhook secret missing) in production. Without this, the webhook
  // endpoint silently accepts unsigned events.
  validateStripeWebhookConfigOrExit();

  // OAUTH_STATE_SECRET: refuse to boot in production if missing or
  // shorter than 16 chars. The accounting integrations (Holded, Sage,
  // A3, NCS) sign their OAuth state with this value. Tests can opt out
  // via ALLOW_WEAK_OAUTH_STATE_SECRET=1.
  validateOAuthStateSecretOrExit();

  const logger = new Logger("Bootstrap");

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: true,
  });

  // L-5 (P2A-receptionist-v2): make Nest use the pino logger from
  // ObservabilityModule for everything (app boot, framework messages,
  // lifecycle hooks). Without this, the pre-module init logs from
  // NestJS itself use the default logger and lose the correlation-id
  // prefix that ObservabilityModule already injects on every request.
  // app.get(PinoLogger) only works after ObservabilityModule is
  // instantiated, which happens during NestFactory.create above.
  app.useLogger(app.get(PinoLogger));

  // Errors reach GlitchTip through SentryExceptionFilter (APP_FILTER in
  // AppModule) and the scheduled-job wrapper. Sentry.setupExpressErrorHandler
  // used to be mounted here, before Nest added its routes, where Nest's own
  // exception handling meant it never saw an error (audit 8 D6).

  applyHttpHardening(app);

  // Browsers post CSP reports as application/csp-report or
  // application/reports+json, which the JSON parser below skips.
  app.use(
    "/api/v1/csp-report",
    json({ type: ["application/csp-report", "application/reports+json"], limit: "64kb" }),
  );
  app.use(
    json({
      verify: (req: any, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
      limit: "5mb",
    }),
  );
  app.use(urlencoded({ extended: true }));

  // Shared with the specs (common/validation/global-validation-pipe.ts).
  app.useGlobalPipes(createGlobalValidationPipe());

  // Salons' pages on <slug>.kiraroom.net and on their verified domains
  // call the API for slots and bookings.
  const webDomains = app.get(WebDomainService);
  app.enableCors(
    buildCorsOptions(parseAllowedOrigins(), logger, (origin) =>
      salonOriginAllowed(origin, webDomains.subdomainBase(), (host) =>
        webDomains.isVerifiedDomain(host),
      ),
    ),
  );
  // After enableCors, so it can translate that middleware's rejection
  // into a 403. Left to Express it answers 500 -- see common/cors.ts.
  app.use(corsRejectionHandler);

  app.setGlobalPrefix('api/v1');

  if (swaggerEnabled()) {
    const config = new DocumentBuilder()
      .setTitle('Kira Room API')
      .setDescription('Beauty Salon Management System API')
      .setVersion('1.0')
      .addBearerAuth()
      .addTag('auth', 'Authentication endpoints')
      .addTag('salons', 'Salon management')
      .addTag('appointments', 'Appointment management')
      .addTag('clients', 'Client management')
      .addTag('services', 'Service management')
      .addTag('professionals', 'Professional management')
      .addTag('virtual-receptionist', 'Virtual receptionist and chat functionality')
      .addTag('widget', 'Booking widget (P0)')
      .addTag('widget-public', 'Public widget embed endpoints (P0)')
      .addTag('qr', 'QR code generator (P0)')
      .addTag('import', 'CSV bulk import (P0)')
      .addTag('ics-feeds', 'Calendar feed endpoints (P0)')
      .addTag('consent-forms', 'Consent form management (P0)')
      .addTag('consent', 'Public consent signing (P0)')
      .addTag('reviews', 'Reviews management (P0)')
      .addTag('reviews-public', 'Public review endpoint (P0)')
      .addTag('reviews-analytics', 'Reviews analytics (P0)')
      .addTag('whatsapp', 'WhatsApp Cloud API connection + campaigns (P0)')
      .addTag('whatsapp-webhooks', 'Meta WhatsApp webhook receiver (P0)')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 3001;
  await app.listen(port);

  logger.log(`Kira Room Backend running on port ${port}`);
  if (swaggerEnabled()) {
    logger.log(`API Documentation: http://localhost:${port}/api/docs`);
  }
}

// ──────────────────────────────────────────────────────────────────
//  Entry-point guard. Running `node dist/main.js` should bootstrap the
//  app; running `import './main'` from a test file should NOT (the
//  latter would try to listen on port 3001 mid-suite). The presence
//  of this guard makes the file safe to import.
// ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal bootstrap error:', err);
    process.exit(1);
  });
}