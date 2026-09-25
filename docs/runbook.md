# Operational runbook

> Living document for the day-to-day operation of KiraRoom SaaS.
> Generated as part of the zero-budget launch roadmap (Sprint 1, Workstream 1.3).
> This is the **only** doc ops should need during normal operation.

## Critical facts (memorize these)

| Item | Value |
|---|---|
| Production API | `https://api.kiraroom.net` |
| Production dashboard (tenants) | `https://app.kiraroom.net` |
| SaaS admin console | `https://admin.kiraroom.net` |
| Commercial website (separate repo) | `https://kiraroom.com` |
| Database host | Hostinger VPS, **NOT** exposed to internet |
| Deploy method | Hostinger hPanel → VPS → Docker Manager → Compose URL |
| Compose source | `https://raw.githubusercontent.com/lagop/KiraRoom/main/docker-compose.prod.yml` |
| Database backup retention | 30 days hot |
| WAL archive retention | 30 days |
| Sentry-compatible error tracking | GlitchTip self-hosted at `https://glitchtip.kiraroom.net` |
| Status page | TBD (free tier: Instatus or BetterStack) |

## Deploy flow

Every push to `main` deploys via **Hostinger Docker Manager** with zero CI deploy steps:

1. **Local**: open a PR from `develop` → `main`. CI (`.github/workflows/ci-cd.yml`)
   runs lint + type-check + backend/frontend tests + a Docker build smoke
   test. No GHCR push, no SSH. The PR template forces you to confirm
   the env var changes, migrations, and rollback plan.
2. **Merge PR** to `main`. Branch protection requires 1 approval and
   all CI checks green.
3. **Open Hostinger hPanel → VPS → Docker Manager → Compose → URL**.
   Paste:
   ```
   https://raw.githubusercontent.com/lagop/KiraRoom/main/docker-compose.prod.yml
   ```
   Click **Deploy**.
4. **Hostinger clones the repo, runs `docker compose up -d --build`**
   with the env vars you've entered in the UI for each service. First
   build takes ~5–10 min (Prisma + Next.js); subsequent rebuilds are
   2–3 min thanks to Docker layer cache.
5. **Smoke test**: visit `http://<vps-ip>:3000` (frontend) and
   `http://<vps-ip>:3001/api/v1/ping` (backend) before pointing DNS.

### Updating after that

Every subsequent deploy:

1. Push changes to `develop`, open a PR, get CI green, merge to `main`.
2. Open Hostinger Docker Manager → your stack → **Redeploy** (or paste
   the URL again if "Redeploy" doesn't re-clone).

If Hostinger's "Redeploy" doesn't re-clone the repo (it depends on
their exact implementation), the workaround is to delete the stack
and recreate it from the URL.

### First-time VPS bootstrap

You do NOT need to SSH into the VPS for the initial deploy. The Hostinger
Docker Manager handles everything as long as Docker is installed on
the VPS (it is by default on Hostinger VPS plans).

If you do need shell access (for certbot first-time issuance, log
inspection, or `docker exec` debugging):

```bash
ssh root@<vps-ip>
# or, if you created a non-root deploy user:
ssh kiraroom@<vps-ip>
```

`ops/deploy/bootstrap-hostinger.sh` is kept as a reference for setting
up a non-root deploy user + certbot + firewall if you choose to harden
beyond the Hostinger defaults. You don't have to run it.
2. **VPS** (`/opt/kiraroom/deploy-prod.sh`):
   - `docker compose -f docker-compose.prod.yml pull` for the new SHA
   - `docker compose ... up -d` — Docker recreates only changed services
   - backend entrypoint runs `prisma migrate deploy` before booting, so
     schema migrations land on every release
   - script waits up to 120 s for the backend healthcheck to go green
   - if healthcheck fails, dumps the last 80 lines of backend logs and
     exits non-zero (CI fails the deploy)

### Legacy: CI-driven deploy via SSH

The Hostinger Docker Manager flow replaced the previous CI → VPS_SSH
flow on 2026-09-10. The old approach (build + push to GHCR, then
`appleboy/ssh-action` to invoke `ops/deploy/deploy-prod.sh`) is kept
in git history if you ever want to resurrect it for multi-VPS or
true zero-touch CI deploys. To do so:

1. Restore the `deploy-production` job in `.github/workflows/ci-cd.yml`.
2. Re-add the GHCR push in the `build` job.
3. Set repo secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`.
4. Restore `image:` references in `docker-compose.prod.yml` (drop the
   `build:` blocks I added in this commit).

### First-time VPS bootstrap (only if you need shell access)

### Adding a new deploy secret

With the Hostinger Docker Manager flow, env vars are entered in the
hPanel UI per service when you create/redeploy the stack. To change
a secret after the initial setup:

1. Open Hostinger hPanel → VPS → Docker Manager → your KiraRoom stack
2. Edit → find the service → update the env var value → Save
3. Hostinger re-deploys the affected service with the new env

For one-off inspection or rotation that the UI doesn't cover, SSH
in:

```bash
ssh root@<vps-ip>
docker exec kiraroom-backend-prod env | grep MINIMAX_API_KEY
# (value will be masked; this is for confirming presence only)
```

### Rotating the LLM provider key

The virtual receptionist and Staff Copilot both call the LLM service.
If a key is revoked or rate-limited:

1. Sign in to the provider dashboard (MiniMax, OpenAI, Anthropic, or
   Google AI Studio depending on which key is rotated).
2. Mint a new key.
3. Open Hostinger hPanel → VPS → Docker Manager → your stack → edit
   the `backend` service → update the matching `*_API_KEY=` env var
   → Save → Hostinger redeploys.
4. Verify a chatbot reply still works in the dashboard — the LLM
   service logs the provider + response time per call.

If rotating `MINIMAX_API_KEY`, also update the per-tenant
`VirtualReceptionistConfig` rows that store the key in the DB
(Hostinger UI doesn't expose DB rows, so this requires SSH + psql
or `npx prisma studio`).

## PagerDuty-equivalent (zero-budget)

Until revenue justifies PagerDuty (€21/user/mo), use:

1. **Uptime Kuma** at `https://kuma.kiraroom.net` with Telegram webhook
   alerts. The Telegram bot pings your phone within 30 seconds of a
   failed health probe.
2. **Critical probes** (every 60s):
   - `GET https://api.kiraroom.net/api/v1/ping` — API health
   - `POST https://api.kiraroom.net/api/v1/auth/login` with test
     credentials — auth + DB health
3. **Warning probes** (every 5min):
   - `GET https://app.kiraroom.net` — dashboard loads
   - `GET https://api.kiraroom.net/api/v1/invoices` — fiscal dispatch reachable

## Operational runbooks

### Failure: API down (no response on /api/v1/ping)

**First, check for the unhealthy-container trap.** Traefik skips containers
whose healthcheck is failing, so an unhealthy backend produces a 404 served
with `CN=TRAEFIK DEFAULT CERT` rather than a 502 — it looks like a TLS or DNS
problem and is neither. Confirm with:

```bash
docker ps -a | grep kiraroom-backend-prod
curl -sk -o /dev/null -w "%{http_code}\n" https://api.kiraroom.net/api/v1/ping
echo | openssl s_client -connect api.kiraroom.net:443 2>/dev/null | openssl x509 -noout -issuer
```

An `Up (unhealthy)` container plus a `TRAEFIK DEFAULT CERT` issuer means the
router was never registered. The container is running; the probe is what
failed.

This happened in September 2026: `/api/v1/ping` was not `@Public()`, so the
global JWT guard answered 401, `wget --spider` treated that as failure, and the
API was unreachable for three days while the process itself was perfectly
healthy. `health-endpoint-public.l4.spec.ts` now guards against it.

1. SSH into the VPS as `kiraroom` (`ssh kiraroom@<vps-ip>`).
2. `docker ps -a` — is the backend container running? Look for
   `kiraroom-backend-prod` with status `Up (healthy)`. If `Restarting`,
   see step 3.
3. `docker logs --tail 200 kiraroom-backend-prod` for the crash reason.
4. If it's a known crash, restart: `docker compose -f /opt/kiraroom/docker-compose.prod.yml --env-file /opt/kiraroom/.env.production up -d backend`.
5. If it's a restart loop, check the database: `docker ps -a` for
   `kiraroom-postgres-prod` status, then `docker logs --tail 100 kiraroom-postgres-prod`.
6. If the database is down, `docker compose -f /opt/kiraroom/docker-compose.prod.yml --env-file /opt/kiraroom/.env.production up -d postgres`, then the backend.
7. If PostgreSQL won't start, check disk space (`df -h`) and `pg_wal/`.

### Failure: Database disk full

1. SSH into the DB host.
2. `df -h` — find which partition is full (usually `/var/lib/postgresql`).
3. `du -sh /var/lib/postgresql/* | sort -h | tail -10` — find big files.
4. If WAL archive is the culprit, ship older segments to backup
   storage: `rsync -avz --remove-source-files /wal-archive/ backup@host:/wal-archive/`.
5. If `pg_dump` files are huge, prune anything older than 30 days
   (the backup script already does this, so this is rare).
6. `VACUUM FULL pg_catalog.pg_attribute;` if the system catalogs are
   bloated (Postgres 13+ usually self-manages).

### Failure: JWT secret leaked (rotate)

This is the **worst-case scenario**. Treat as SEV1.

1. Generate a new 32-byte secret: `openssl rand -base64 32`.
2. SSH into the VPS as `kiraroom`. Edit `/opt/kiraroom/.env.production`
   and replace `JWT_SECRET=...` with the new value.
3. `cd /opt/kiraroom && docker compose -f docker-compose.prod.yml --env-file .env.production up -d backend`.
4. All existing JWTs are now invalid. Users will be forced to log in
   again (a fresh token is issued from `POST /auth/login`).
5. Audit `audit_logs` for any unusual activity in the previous hours.
6. Consider rotating tenant secrets too (META_TOKEN_ENCRYPTION_KEY,
   OAUTH_STATE_SECRET, etc.).
7. Document the incident in a post-mortem at `docs/post-mortems/`.

### Design note: `POST /auth/impersonate` is intentionally `@Public()`

**SEC-4.** This endpoint lives at
`packages/backend/src/auth/auth.controller.ts:44` and carries the
`@Public()` decorator. Future engineers will see `@Public()` on a
clearly sensitive route and assume it's a bug. **It is not — do not
"fix" it.** This section is the canonical explanation.

**Why it's `@Public()`:** the SaaS owner's 60-second impersonation JWT
*is* the auth credential. It is minted by
`POST /saas/tenants/:id/launch` (SaaS owner authenticated), handed to
the browser, and posted once to `/auth/impersonate` to be exchanged for
a real tenant-owner session. There is no other credential the browser
has at that point — no cookie, no bearer header.

**Why removing the decorator would break the flow:** if the route
required the standard `JwtAuthGuard`, the browser would need a valid
tenant-owner JWT before calling it — which is exactly what we're trying
to mint. Chicken-and-egg.

**Why the open exposure is bounded:** `AuthService.impersonate()`
(`packages/backend/src/auth/auth.service.ts:336-385`) re-validates the
incoming token internally:

- Signature verified with `ignoreExpiration: false`.
- `payload.aud === IMPERSONATION_AUDIENCE` asserted.
- Payload must carry `impersonate.tenantId`, `impersonate.ownerId`,
  and a `jti` (used for single-use enforcement via the
  `used_impersonation_tokens` table).
- Target tenant owner must exist and be active.
- TTL hard-capped at 60s (`IMPERSONATION_TTL_SECONDS` in
  `saas.constants.ts`).

Every successful call writes an `audit_logs` row
(`action: 'saas.impersonate'`, `actorId` = SaaS owner, `tenantId` =
impersonated tenant). The dashboard renders a persistent red banner
while impersonation is active.

**Acceptance criteria for "fixing" this in the future:** any change
must keep all four guards above intact AND keep the per-call audit
log. If a PR removes `@Public()` without satisfying those, **block
the PR** and link to this section.

Full impersonation flow (end-to-end): `docs/saas-admin-runbook.md`
§5.

### Failure: GDPR export request (right of access, Art. 15 RGPD)

1. SaaS owner calls `POST /api/v1/saas/tenants/:id/export` (or uses the
   SaaS admin UI).
2. The response is a JSON envelope containing a base64-encoded gzip
   bundle of every model that references the tenant.
3. Decode + decompress in one step:
   ```bash
   cat export.json | jq -r '.data' | base64 -d | gunzip > tenant-export.json
   ```
4. Forward `tenant-export.json` to the customer within **30 days** of
   the request (Art. 12(3) RGPD).
5. The `GdprRequest` row has `status=completed` for the audit trail.

### Failure: GDPR erasure request (right to be forgotten, Art. 17)

1. SaaS owner calls `POST /api/v1/saas/tenants/:id/anonymize`.
2. The endpoint soft-replaces PII fields with `[anonymized]` placeholders.
   Invoice records are **preserved** for fiscal compliance (4-year
   retention under Art. 66 RGGI) but their recipient data is anonymized.
3. After completion, the `Tenant.deletedAt` is set to `now()`.
4. Read-only access remains for 30 days to allow data export.
5. After 60 days of inactivity, the PII is fully purged from backups via
   the next backup cycle.
6. Document the request in the `GdprRequest` audit row.

### Failure: Stripe webhooks returning 503

**SEC-3.** If Stripe's dashboard starts showing redeliveries against
`https://api.kiraroom.net/api/v1/webhooks/stripe`, the runtime guard
in `WebhooksController.handleStripeWebhook()` is doing its job:

- **Missing `STRIPE_WEBHOOK_SECRET` in production** → 503
  (`SERVICE_UNAVAILABLE`). The startup check in `main.ts`
  (`assertStripeWebhookConfig`) should prevent this from ever
  happening — if it does, the config drifted after boot (someone
  edited `.env` without restarting, or the secret rotation script
  failed).
- **Missing `stripe-signature` header in production** → 503. A
  signature-less webhook on a secret-configured endpoint is always
  operator error or an attacker — never process it.

**Recovery:**

1. SSH into the API host. Confirm `STRIPE_WEBHOOK_SECRET` matches the
   value in the Stripe dashboard (Developers → Webhooks → endpoint
   → Reveal signing secret). The value must start with `whsec_`.
2. If the secret was lost, click "Roll secret" in the Stripe
   dashboard, copy the new value, set it in
   `/opt/kiraroom/.env.production`, and
   `docker compose -f /opt/kiraroom/docker-compose.prod.yml --env-file /opt/kiraroom/.env.production up -d backend`.
3. Once the API is healthy, click "Resend" on the failed events in
   the Stripe dashboard (or wait for Stripe's automatic retry —
   intervals are 1m, 5m, 30m, 2h, 12h, 24h, 2d, 3d).

**Escape hatch** (do NOT use in production): setting
`ALLOW_UNVERIFIED_STRIPE_WEBHOOK=1` lets the endpoint accept
unsigned events. Only ever set this in a staging environment or in a
unit test runner.

### Failure: Fiscal dispatch failing (AEAT 5xx)

1. Check `GlitchTip` for the error rate spike. Filter by tag `fiscal`.
2. Most AEAT failures are transient. The retry queue handles 3 retries
   over 5min/30min/2h.
3. If failures persist >30 minutes:
   - Check `https://prewww2.aeat.es` status — AEAT might be down for
     maintenance (announced in advance).
   - Check the cert on file (`POST /invoices/certificates/list`) —
     has it expired? `notAfter` field is critical.
   - For TBAI, check `https://prewww.batuz.eus` status.
4. For permanent failures (AEAT 4xx), inspect the XML envelope stored
   in `Invoice.fiscalXml`. AEAT response usually contains an error code
   that pinpoints the schema issue.
5. Once root cause is fixed, trigger manual retry: `POST /invoices/:id/resend-fiscal`.

### Backups: how they run

The `postgres-backup` service in `docker-compose.prod.yml` dumps the whole
database once a day at 03:15 UTC with `pg_dump -Fc`, into the
`postgres_backups` volume, and prunes dumps older than
`BACKUP_RETENTION_DAYS` (default 14).

```bash
# List what exists
docker exec kiraroom-postgres-backup-prod ls -lh /backups

# Force a dump now (does not disturb the schedule)
docker exec kiraroom-postgres-backup-prod sh -c \
  'PGPASSWORD=$POSTGRES_PASSWORD pg_dump -h postgres -U kiraroom -d kiraroom -Fc -f /backups/manual-$(date -u +%Y%m%dT%H%M%SZ).dump'

# Restore a whole database (DESTRUCTIVE -- confirm the target first)
docker exec kiraroom-postgres-backup-prod sh -c \
  'PGPASSWORD=$POSTGRES_PASSWORD pg_restore -h postgres -U kiraroom -d kiraroom --clean --if-exists /backups/<file>.dump'

# Restore ONE table (the reason for -Fc)
docker exec kiraroom-postgres-backup-prod sh -c \
  'PGPASSWORD=$POSTGRES_PASSWORD pg_restore -h postgres -U kiraroom -d kiraroom -t clients /backups/<file>.dump'
```

**Still pending:** the dumps live on the same VPS volume as the database, so
they survive an accidental delete but not a host loss. Off-site copies and
WAL archiving (`docs/wal-archiving.md`) for point-in-time recovery are the
next step, and are what the quarterly restore drill below should exercise.

### Failure: Backup fails to run

1. Read the service log: `docker logs kiraroom-postgres-backup-prod --tail 50`.
   A failed dump logs `[backup] FAILED for <stamp>` and leaves no `.partial`
   file behind.
2. If nothing is logged at all, the container is not running:
   `docker ps -a | grep postgres-backup`, then `docker compose up -d postgres-backup`.
3. Most common real cause: disk full on the VPS. Check with `df -h`, then
   prune manually: `docker exec kiraroom-postgres-backup-prod sh -c 'find /backups -name "kiraroom-*.dump" -mtime +7 -delete'`.
4. Second most common: `POSTGRES_PASSWORD` rotated in the backend env but not
   redeployed to this service. Both read the same variable, so redeploy the
   whole compose file rather than a single container.

### Failure: TLS certificate expires

1. Check expiry: `echo | openssl s_client -connect api.kiraroom.net:443 -servername api.kiraroom.net 2>/dev/null | openssl x509 -noout -enddate`.
2. Renew via Let's Encrypt. The `kiraroom-certbot` sidecar in
   `docker-compose.prod.yml` renews every 12 h and writes to
   `/etc/letsencrypt/`, which nginx reads. To force a renewal:
   `docker exec kiraroom-certbot certbot renew --force-renewal`.
3. Reload nginx to pick up the new cert:
   `docker exec kiraroom-nginx-prod nginx -s reload`.
4. Verify: `curl -I https://api.kiraroom.net/api/v1/ping`.

## Quarterly restore drill

Required by the zero-budget launch roadmap (Workstream 1.3):

1. **Schedule** a 2-hour calendar block.
2. Stop the running API.
3. **Restore** the most recent backup to a **fresh staging DB** using
   `scripts/restore.sh`. Do NOT restore to production.
4. Run `npm test` against the staging DB to verify consistency.
5. **Time the restore**. This is the documented RTO. Update this runbook
   with the new figure.
6. If the drill reveals issues, fix them before the next backup window
   opens (within 24 hours).

The first drill is scheduled during the zero-budget launch (Day 7 of
Sprint 1).

### Restore drill log

| Date | DB size | Restore wall-clock | RTO (target ≤ 30 min) | Tester | Issues found |
|---|---|---|---|---|---|
| _PENDING — first drill, Day 7 of Sprint 1_ | — | — | **TBD** | — | — |

> **Action item**: execute the first drill, fill the row above, and
> commit the result. Until then, **RTO is unverified** — treat the
> 30-minute target as a hypothesis, not a guarantee.

## Deployment

Every deploy follows this checklist:

- [ ] All env vars set in production `.env`
- [ ] Database migrations applied: `npm run db:push` (or `prisma migrate deploy` once we have migrations)
- [ ] JWT_SECRET + META_TOKEN_ENCRYPTION_KEY are 32+ byte random values
- [ ] CORS_ALLOWED_ORIGINS is set to specific origins (NOT wildcard)
- [ ] `NODE_ENV=production`
- [ ] `npm run build` produces no warnings
- [ ] `npm test` passes
- [ ] Healthcheck responds 200

## When things go really wrong

### Post-mortem template (blameless)

After any SEV1 (production outage, security incident, data loss):

1. **Within 24 hours**, schedule a post-mortem meeting.
2. Use the template at `docs/post-mortems/template.md`.
3. Focus on **systems and decisions**, not individuals. The question is
   "what did the system allow us to do?" not "who did this?"
4. Produce 3-5 actionable items with owners and deadlines.
5. Track them in the issue tracker. They are not optional.

### When to escalate

- **SEV1** (production down, data loss, security incident with user
  data exposure): page the on-call engineer immediately. Notify affected
  customers within 1 hour.
- **SEV2** (degraded service, non-critical error rate spike): email the
  team. Notify customers within 24 hours.
- **SEV3** (minor bug, cosmetic, performance regression): ticket in the
  backlog. Fix in the next sprint.

## Useful one-liners

```bash
# Check API logs for a specific tenant
docker logs kiraroom-backend-prod --since 1h 2>&1 | grep "tenant=<TENANT_ID>"

# Watch the fiscal dispatch queue
docker exec kiraroom-redis-prod redis-cli LLEN bull:fiscal-dispatch:waiting

# Tail all errors from the last 5 minutes
docker logs kiraroom-backend-prod --since 5m 2>&1 | grep -i error

# Confirm a tenant's fiscal mode is set correctly
docker exec kiraroom-postgres-prod psql -U kiraroom kiraroom \
  -c "SELECT id, fiscal_mode, fiscal_settings->'tenantNif' FROM tenants WHERE id = '<TENANT_ID>';"
```
