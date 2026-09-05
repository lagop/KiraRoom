# Operational runbook

> Living document for the day-to-day operation of KiraRoom SaaS.
> Generated as part of the zero-budget launch roadmap (Sprint 1, Workstream 1.3).
> This is the **only** doc ops should need during normal operation.

## Critical facts (memorize these)

| Item | Value |
|---|---|
| Production API | `https://api.kiraroom.com` |
| Production dashboard | `https://app.kiraroom.com` |
| Database host | Internal Hetzner VPS, **NOT** exposed to internet |
| Backup host | Hetzner Storage Box, `backup@backup-host:/backups/` |
| WAL archive | Hetzner Storage Box, `backup@backup-host:/wal-archive/` |
| Database backup retention | 30 days hot |
| WAL archive retention | 30 days |
| Sentry-compatible error tracking | GlitchTip self-hosted at `https://glitchtip.kiraroom.com` |
| Status page | TBD (free tier: Instatus or BetterStack) |

## PagerDuty-equivalent (zero-budget)

Until revenue justifies PagerDuty (€21/user/mo), use:

1. **Uptime Kuma** at `https://kuma.kiraroom.com` with Telegram webhook
   alerts. The Telegram bot pings your phone within 30 seconds of a
   failed health probe.
2. **Critical probes** (every 60s):
   - `GET https://api.kiraroom.com/healthz` — API health
   - `POST https://api.kiraroom.com/api/v1/auth/login` with test
     credentials — auth + DB health
3. **Warning probes** (every 5min):
   - `GET https://app.kiraroom.com` — dashboard loads
   - `GET https://api.kiraroom.com/api/v1/invoices` — fiscal dispatch reachable

## Operational runbooks

### Failure: API down (5xx response on healthz)

1. SSH into the API host (`ssh api.kiraroom.com`).
2. `systemctl status kira-api` — is the service running?
3. If not, `journalctl -u kira-api --since "5 minutes ago" -n 100` for the
   crash reason.
4. If it's a known crash, restart: `systemctl restart kira-api`.
5. If it's a crash loop, check the database: `systemctl status postgresql`.
6. If the database is down, restart PostgreSQL, then the API.
7. If PostgreSQL won't start, check disk space and `pg_wal/`.

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
2. SSH into API host. Edit `.env` and replace `JWT_SECRET=...` with the
   new value. `systemctl restart kira-api`.
3. All existing JWTs are now invalid. Users will be forced to log in
   again (a fresh token is issued from `POST /auth/login`).
4. Audit `audit_logs` for any unusual activity in the previous hours.
5. Consider rotating tenant secrets too (META_TOKEN_ENCRYPTION_KEY,
   OAUTH_STATE_SECRET, etc.).
6. Document the incident in a post-mortem at `docs/post-mortems/`.

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
`https://api.kiraroom.com/api/v1/webhooks/stripe`, the runtime guard
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
   dashboard, copy the new value, set it in `.env`, and
   `systemctl restart kira-api`.
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

### Failure: Backup fails to run

1. Check the cron log: `grep CRON /var/log/syslog | grep backup`.
2. Most common cause: SSH key for off-site rsync expired. Re-add:
   `ssh-copy-id backup@<BACKUP_HOST>`.
3. Second most common: disk full on the backup host. SSH in and prune
   `find /backups -mtime +30 -delete`.
4. Verify by running the script manually: `sudo -u kira /opt/kiraroom/scripts/backup.sh`.

### Failure: TLS certificate expires

1. Check expiry: `echo | openssl s_client -connect api.kiraroom.com:443 -servername api.kiraroom.com 2>/dev/null | openssl x509 -noout -enddate`.
2. Renew via Let's Encrypt (certbot) or your CA. Auto-renewal via
   certbot.timer should already be configured.
3. Reload the reverse proxy: `systemctl reload nginx`.
4. Verify: `curl -I https://api.kiraroom.com/healthz`.

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
journalctl -u kira-api --since "1 hour ago" | grep "tenant=<TENANT_ID>"

# Watch the fiscal dispatch queue
watch -n 5 "redis-cli LLEN bull:fiscal-dispatch:waiting"

# Tail all errors from the last 5 minutes
journalctl -u kira-api --since "5 minutes ago" -p err

# Confirm a tenant's fiscal mode is set correctly
psql "$DATABASE_URL" -c "SELECT id, fiscal_mode, fiscal_settings->'tenantNif' FROM tenants WHERE id = '<TENANT_ID>';"
```
