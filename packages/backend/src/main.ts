import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { json, urlencoded } from "express";
import * as Sentry from "@sentry/node";
import { Logger as PinoLogger } from "nestjs-pino";
import { AppModule } from "./app.module";
import {
  validateJwtSecretOrExit,
  validateStripeWebhookConfigOrExit,
  validateOAuthStateSecretOrExit,
} from "./startup-checks";

const SENTRY_DSN = process.env.SENTRY_DSN || process.env.GLITCHTIP_DSN;
const SENTRY_TRACES_SAMPLE_RATE = Number(
  process.env.SENTRY_TRACES_SAMPLE_RATE || "0.1",
);

function initSentry(): void {
  if (!SENTRY_DSN) {
    // No DSN configured — silently skip. This keeps `npm run dev`,
    // `npm test`, and CI builds running without an outbound network
    // dependency. Setting SENTRY_DSN or GLITCHTIP_DSN in the
    // environment is the entire activation step.
    return;
  }
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    // Strip PII before sending. Anything in `event.request.data` is
    // either a request body (which may contain PII: tax IDs, names,
    // emails) or a payload we explicitly do not want a third-party
    // Sentry-compatible host to see. The host is self-hosted
    // (GlitchTip), but defense in depth is cheap.
    beforeSend(event) {
      if (event.request) {
        if (event.request.data) delete event.request.data;
        if (event.request.cookies) delete event.request.cookies;
        // Spanish endpoints commonly accept PII via query parameters
        // (e.g. `GET /clients?taxId=B12345678`). Strip the querystring
        // before the URL leaves the box.
        if (event.request.url) {
          try {
            const u = new URL(event.request.url);
            u.search = "";
            event.request.url = u.toString();
          } catch {
            /* not a parseable URL — leave alone */
          }
        }
        if (event.request.query_string) delete event.request.query_string;
      }
      if (event.user) {
        // Replace with a tenant-scoped opaque id; never send email.
        if (event.user.email) delete event.user.email;
        if (event.user.ip_address) delete event.user.ip_address;
      }
      return event;
    },
    // Same scrubbing applies to breadcrumbs (e.g. fetch() calls).
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.data?.url) {
        try {
          const u = new URL(breadcrumb.data.url);
          u.search = "";
          breadcrumb.data.url = u.toString();
        } catch {
          /* not a parseable URL — leave alone */
        }
      }
      return breadcrumb;
    },
  });
}

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
  initSentry();

  // SEC-1: fail fast on a missing or weak JWT secret. Tests can opt
  // out via ALLOW_WEAK_JWT_SECRET=1.
  validateJwtSecretOrExit();

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

  if (SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
  }

  app.use(
    json({
      verify: (req: any, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
      limit: "5mb",
    }),
  );
  app.use(urlencoded({ extended: true }));

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
      validationError: {
        target: true,
        value: true,
      },
    }),
  );

  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes('*')) {
        logger.warn(
          'CORS_ALLOWED_ORIGINS contains "*" — allowing all origins. ' +
            'Set a specific allow-list before going to production.',
        );
        return cb(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      logger.warn(`CORS blocked origin: ${origin}`);
      return cb(new Error('Origin not allowed by CORS policy'), false);
    },
    credentials: true,
  });

  app.setGlobalPrefix('api/v1');

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

  const port = process.env.PORT || 3001;
  await app.listen(port);

  logger.log(`Kira Room Backend running on port ${port}`);
  logger.log(`API Documentation: http://localhost:${port}/api/docs`);
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