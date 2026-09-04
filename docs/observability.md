# Observability — Sprint 1 zero-budget stack

This document explains the three pieces of the self-hosted observability
stack delivered in Sprint 1 of the zero-budget launch roadmap, how they
fit together, and how to operate them.

| Piece | Purpose | Cost | Where it lives |
|---|---|---|---|
| **nestjs-pino** | Structured JSON logs, one line per request + one line per `Logger.log()` call, with correlation IDs | €0 (free) | `packages/backend/src/common/observability/logger.config.ts` |
| **`@sentry/node` + GlitchTip** | Error tracking + APM traces | €0 (self-hosted GlitchTip) | `docker-compose.observability.yml` |
| **`CorrelationIdMiddleware`** | Per-request id propagated through `AsyncLocalStorage` | €0 (Node built-in) | `packages/backend/src/common/observability/correlation.middleware.ts` |

## How correlation IDs flow

```
HTTP request
  └─ X-Request-Id header (or randomUUID())
       ├─ set as req.id   → pino-http uses it on the access log
       ├─ set on response header X-Request-Id
       └─ stored in AsyncLocalStorage
            └─ every Logger.log() in the request handler chain
               picks it up via customProps
```

Every JSON log line emitted during a request includes:

```json
{
  "level": "info",
  "time": "2026-07-17T17:34:01.234Z",
  "requestId": "5e8b...",
  "tenantId": "tnt_...",
  "req": { "method": "POST", "url": "/api/v1/invoices" },
  "res": { "statusCode": 201 },
  "msg": "request completed"
}
```

## How Sentry (GlitchTip) is wired

1. `initSentry()` in `packages/backend/src/main.ts` reads
   `SENTRY_DSN` (or `GLITCHTIP_DSN`). If unset, Sentry is skipped —
   dev and CI keep running without network egress.
2. `Sentry.setupExpressErrorHandler(app)` is attached so any
   unhandled error thrown by a controller becomes a Sentry event.
3. `beforeSend` strips PII (request body, cookies, user email,
   IP address) before the event leaves the box.
4. Traces sample at 10% by default — adjust via
   `SENTRY_TRACES_SAMPLE_RATE`.

The host GlitchTip container is defined in `docker-compose.observability.yml`
and accepts the same DSN format as Sentry SaaS — `@sentry/node` does not
know or care which host is on the other end.

## Enabling in production

Set in `.env`:

```bash
SENTRY_DSN=https://<public-key>@glitchtip.kirastudio.com/<project-id>
SENTRY_TRACES_SAMPLE_RATE=0.1
LOG_LEVEL=info
```

Restart the API. Within ~30 seconds the first event will appear in
GlitchTip. Verify with:

```bash
curl -s https://glitchtip.kirastudio.com/api/0/projects/ \
  -H "Authorization: Bearer $GLITCHTIP_USER_TOKEN" | jq
```

## Logs vs Sentry — what goes where

| Event class | Where it goes |
|---|---|
| Every HTTP request | pino JSON log line (always) |
| Successful business events | pino JSON log line |
| Caught + rethrown errors | pino WARN + Sentry breadcrumb |
| Unhandled errors / 5xx | pino ERROR + Sentry event |
| Background job failures | pino ERROR + Sentry event |

Pino is the source of truth for "what happened". Sentry is the source
of truth for "what went wrong + how often + where".

## Operating GlitchTip

```bash
# Bring up the stack
docker compose -f docker-compose.observability.yml up -d

# Tail GlitchTip logs
docker compose -f docker-compose.observability.yml logs -f glitchtip

# Rotate the GlitchTip secret key (in `.env`):
openssl rand -base64 32 > GLITCHTIP_SECRET_KEY
docker compose -f docker-compose.observability.yml up -d glitchtip
```

Backups of the GlitchTip Postgres are not critical — losing the host
loses ~30 days of error history, not customer data. Re-adding a DSN
is a 1-line config change.

## Adding structured logs to a new module

```typescript
import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class MyService {
  private readonly logger = new Logger(MyService.name);

  doStuff() {
    this.logger.log({ tenantId: "tnt_..." }, "did stuff");
  }
}
```

The `{ tenantId: ... }` object is treated as **bindings** by pino and
merged into the JSON line. The message string goes to `msg`. Avoid
passing PII (names, NIFs, emails) as bindings — those belong in the
database, not the log pipeline.

## Migration to Datadog / Grafana Cloud (Sprint 3)

When MRR justifies it, swap `pino-http` output to a Datadog Agent or
HTTP sink. Because we already emit structured JSON, this is a config
change only — no application code changes.