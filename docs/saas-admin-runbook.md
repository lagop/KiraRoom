# SaaS Admin Runbook

**Owner:** Platform Engineering
**Status:** Living document — keep in sync with `packages/backend/src/saas/` and `packages/frontend/app/saas/`.

This runbook documents the **platform-admin** surface (a.k.a. "KiraSaaS dashboard") that lets a SaaS owner manage every tenant salon from one place. Tenant-side concerns (each salon's own dashboard) are documented in their respective onboarding guides and not repeated here.

---

## 1. Login

- URL: **`/saas/login`** (e.g. `https://app.kira-room.example.com/saas/login`)
- Default credentials (created by `prisma db:seed:saas`):
  - `saasadmin@example.com` / `YourSecurePassword123!`
  - Override at boot via `SAAS_OWNER_EMAIL` / `SAAS_OWNER_PASSWORD`. The e2e fixture reads from these env vars first (`e2e/fixtures/auth.ts`).
- **Production**: rotate the password immediately. The bcrypt hash in `packages/backend/prisma/seed-saas-owner.ts` is only a dev placeholder.

---

## 2. Provisioning a tenant manually

There are two entry points:

1. **Self-service signup** — `POST /auth/register` from the public marketing page (`/`). The signup form on `/signup` is the canonical path. It auto-assigns a 14-day Pro trial per plan rev 3.
2. **Manual provisioning** — used by support or sales.

For (2), the SaaS owner clicks "Add salon" in the SaaS dashboard (`/saas/tenants/new`) and submits:

- Salon name, slug (auto-generated if blank), country, language, currency.
- Owner email, first name, last name.
- Initial password (or use the default `ChangeMe123!` placeholder, which the owner must reset on first login).

The endpoint `POST /saas/tenants` returns the new `tenant.id`. Seed the owner user with the same endpoint — that flow is `SaasService.createTenant`.

For tests, `e2e/fixtures/auth.ts` provides `seedTenant({...})` which does this for you and returns `{ tenantId, ownerEmail, ownerPassword, slug }`.

---

## 3. Suspending / reactivating a tenant

From `/saas/tenants`:

- Click the **Suspend** icon on a row → calls `POST /saas/tenants/:id/suspend`. Backend sets `subscriptionStatus='cancelled'`. The salon is read-only until reactivated.
- Click **Reactivate** → `POST /saas/tenants/:id/reactivate`. Sets `subscriptionStatus='active'`.

Suspended tenants can still log in (the dashboard layout doesn't reject them), but writes go to a soft-fail state in `FeatureFlagService`. If you want to fully lock a tenant out, see "Soft-deleting a tenant" below.

---

## 4. Reading KPIs

The platform overview at `/saas` shows:

- **Total tenants / users / clients / appointments** — counts across every non-deleted tenant.
- **MRR** — `Σ (active tenants on plan P) × PLAN_PRICES[P]`, where `PLAN_PRICES` lives in `packages/backend/src/saas/saas.constants.ts`. **Trialing tenants contribute 0**; past-due and cancelled are excluded from MRR but counted elsewhere.
- **Active subscriptions / trial / churned** — counts by `subscriptionStatus`.
- **Top countries / plan distribution** — groupBy aggregations.
- **New tenants / users this month** — count where `createdAt >= startOfMonth`.

Time-series charts at `/saas/analytics/growth?months=6` and per-salon at `/saas/tenants/:id/growth?months=6`. Both compute revenue from `Payment`/`Appointment` rows where `paymentStatus='paid'`.

---

## 5. Impersonating a tenant owner

The "external-link" button on a tenant row is the SaaS-support escape hatch. It logs you in as that tenant's owner so you can investigate a problem from their seat.

**Flow:**
1. SaaS owner clicks the launch icon on `/saas/tenants`.
2. Frontend calls `POST /saas/tenants/:id/launch`. Backend returns a signed JWT (TTL 60s, audience `impersonation`) and the owner's profile.
3. Frontend redirects to `/login?as_owner=&token=&owner=` with the token in the URL.
4. `/login` consumes the token via `POST /auth/impersonate`. The backend validates the audience + signature, mints a real session for the tenant owner, and writes an `AuditLog` row (`action: 'saas.impersonate'`).
5. Browser is redirected to `/dashboard?impersonated=1`. The dashboard layout renders a persistent red banner: *"You are impersonating this tenant. Every action you take is attributed to your account in the `audit_logs` table."* with an **Exit** button.
6. **Exit** removes both tokens, logs the user out, and routes to `/saas/login`. The SaaS owner must log in again (we cannot restore their session — the impersonation token was the only auth they had).

**Audit trail:** every impersonation creates one `audit_logs` row with `actorId` = SaaS owner's user id, `tenantId` = impersonated tenant, `metadata.reason` = `support` (configurable from frontend in future).

**Limits:**
- JWT TTL hard-capped at 60s (`IMPERSONATION_TTL_SECONDS` in `saas.constants.ts`).
- Impersonation only works against tenants where `deletedAt IS NULL`.

---

## 6. Soft-delete + how to recover

There is no hard-delete in the SaaS UI anymore. When you click the trash icon on a tenant row:

1. `POST /saas/tenants/:id/delete` calls `SaasService.deleteTenant`, which sets `Tenant.deletedAt = NOW()`.
2. An `AuditLog` row records `action: 'tenant.soft_delete'`.
3. The tenant disappears from `/saas/tenants` (filtered by `where: { deletedAt: null }`).
4. **All child rows are preserved** — users, appointments, payments, etc. — so an accidental delete is reversible.

To restore a soft-deleted tenant:

```sql
-- Run via `prisma studio` or psql
UPDATE tenants SET "deletedAt" = NULL WHERE id = '<tenant-uuid>';
```

To list tenants including deleted ones (SaaS admin only):

- `GET /saas/tenants?includeDeleted=true` — wired through `TenantFilterDto.includeDeleted`. The frontend `/saas/tenants` page can be extended with a "show deleted" toggle. (Plan: defer UI until needed.)

---

## 7. Plan catalog (rev 3)

Three plans, trialing tenants sit on **Pro** functionally regardless of their stored `plan`:

| Plan       | Tenant price | Notes                                  |
| ---------- | ------------ | -------------------------------------- |
| `esencial` | €29 / mo     | Basic booking, 1 location              |
| `pro`      | €59 / mo     | Adds WhatsApp reminders, AI receptionist |
| `empresa`  | €119 / mo    | Multi-location, requires ≥ 2           |

Source of truth: `packages/backend/src/saas/saas.constants.ts` (`PLAN_PRICES`). The full plan catalog with features lives in `subscriptionsService.getPublicPlans()` and is exposed at `GET /payments/subscription/plans` for the marketing landing.

---

## 8. Schema reference (relevant models)

| Model      | Where                                                       | Notes                                                     |
| ---------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| `Tenant`   | `packages/backend/prisma/schema.prisma:10`                  | Has `deletedAt` (soft-delete) + `plan`, `subscriptionStatus` |
| `User`     | `schema.prisma:93`                                          | Back-relation `auditLogs` (`AuditLogActor`)              |
| `AuditLog` | `schema.prisma` (rev 20260708170000)                        | Append-only; `actorId` FK Restrict, `tenantId` FK SetNull |
| Migration  | `packages/backend/prisma/migrations/20260708170000_*`       | Adds `deletedAt` + `audit_logs` table                    |

---

## 9. Common gotchas

- **`/saas/tenants?includeDeleted=true`** is opt-in. SaaS listings default to active tenants only.
- **Middleware**: `packages/frontend/middleware.ts` is intentionally permissive for SaaS routes — authentication is enforced by the backend `SaasOwnerGuard`. The dashboard layout's `useEffect` is a UX redirect, not a security gate.
- **Soft-deleted tenants still own active subscriptions** in Stripe. If the SaaS owner wants to fully stop billing, cancel the subscription in Stripe separately. (Future enhancement: cancel Stripe sub on `soft_delete`.)
- **`AuditLog.actorId` is a hard FK to `User` with `onDelete: Restrict`** — deleting a SaaS owner user will fail if they have audit entries. This is intentional: the audit trail must never dangle.

---

## 10. Where to look in code

| Concern                     | File                                                              |
| --------------------------- | ----------------------------------------------------------------- |
| Backend SaaS module         | `packages/backend/src/saas/saas.{controller,service,module}.ts`  |
| SaaS constants (TTL, prices) | `packages/backend/src/saas/saas.constants.ts`                     |
| Auth impersonation handler  | `packages/backend/src/auth/auth.controller.ts` (`/auth/impersonate`) |
| Seed for SaaS admin          | `packages/backend/prisma/seed-saas-owner.ts`                      |
| Frontend SaaS layout        | `packages/frontend/app/saas/layout.tsx`                           |
| Frontend SaaS login         | `packages/frontend/app/saas/login/page.tsx`                       |
| Frontend SaaS tenants       | `packages/frontend/app/saas/tenants/page.tsx`                     |
| Impersonation banner        | `packages/frontend/app/dashboard/layout.tsx`                      |
| E2E SaaS spec               | `e2e/06-saas-admin.spec.ts`                                       |
| Unit tests (SaasOwnerGuard) | `packages/backend/src/saas/guards/saas-owner.guard.spec.ts`      |

---

## 11. Deploying a SaaS-related change

Backend code in this folder routinely introduces new Prisma migrations and writes to `audit_logs`/`used_impersonation_tokens`. Two failure modes have burned us:

1. **Out-of-order rollout.** The new backend container reaches the load balancer before `prisma migrate deploy` has been run against the production DB. Every `POST /auth/impersonate` and every `DELETE /saas/tenants/:id` throws P2021 ("relation does not exist") until someone runs the migration manually. The SaaS admin console is hard-broken.
2. **Orphan soft-delete writes from the nightly cron.** If `expireTrials` / `archiveStaleReadOnly` run before the soft-delete filtering migration is applied (or before the new code is deployed), they will resurrect billing state on tenants that have already been soft-deleted by a SaaS admin.

**Required deploy order:**

```bash
# 1. Apply pending migrations BEFORE the new code can serve traffic.
cd packages/backend
npx prisma migrate deploy
# Confirm: "All migrations have been successfully applied."

# 2. Roll the new container / push the new release.
```

The CI pipeline in `.github/workflows/ci-cd.yml` runs migrations only on the test pipeline — production deploys must run them explicitly as a gate. If your platform supports pre-deploy hooks (Kubernetes init containers, ECS `command` overrides, `docker-compose` `entrypoint` wrappers), wrap the start command:

```bash
npx prisma migrate deploy && node dist/main.js
```

**Verification after rollout:**

```bash
curl -fsS https://api.example.com/api/v1/saas/analytics/overview \
  -H "Authorization: Bearer $SAAS_JWT"
```

If the response is `PrismaClientKnownRequestError: relation "audit_logs" does not exist` or `relation "used_impersonation_tokens" does not exist`, the migration step was missed.

**Cron safety:** the `deletedAt: null` filters are added alongside the column in the same migration that introduces `Tenant.deletedAt`, so the crons honor soft-delete on the same deploy as the schema change.


## Facturas rechazadas por AEAT (Verifactu / TicketBAI)

Cuando un tenant opera en producci�n, las facturas pueden fallar en el endpoint fiscal por varias razones. Esta secci�n documenta el diagn�stico y la recuperaci�n.

### S�ntomas t�picos

- El owner recibe un email con subject Factura {numero} rechazada por AEAT.
- En el dashboard de facturas, el campo iscalStatus aparece como error o ejected en lugar de ccepted.
- El iscalRetryCount se acerca a 3 y luego se queda en 3.

### Diagn�stico paso a paso

1. **Lee el iscalError** de la factura rechazada. Los patrones m�s comunes:
   - AEAT 400 � ? problema de esquema (NIF mal formado, falta campo obligatorio).
   - AEAT 5xx � ? transitorio (downstream ca�do), ya reintentado autom�ticamente.
   - AEAT 422 � ? factura duplicada (mismo NumSerieFactura que una previa).
   - PKCS#12 MAC could not be verified ? contrase�a del certificado mal escrita, o certificado expirado.
   - No active fiscal certificate ? el tenant no ha subido .p12 a�n.

2. **Verifica el certificado** en /dashboard/settings/fiscal:
   - 
otAfter debe ser > hoy. Si est� expirado, pide al tenant que suba uno nuevo v�a POST /api/v1/invoices/certificates con el pkcs12Base64 del nuevo .p12.
   - El passphrase debe coincidir exactamente. Encriptamos ambos lados con EncryptionService as� que un error de tipo solo es detectable intentando descifrar.

3. **Verifica el NIF**:
   - Tenant.taxId debe ser un NIF/CIF/NIE v�lido (regex en 
if.validator.ts).
   - El campo iscalMode debe ser erifactu o 	icketbai (no 
one).

4. **Comprueba el chain**:
   - FiscalChainState.lastHash no debe estar corrupto. Si lo est�, ejecuta manualmente:
     `	s
     await prisma.fiscalChainState.delete({ where: { tenantId_fiscalMode: { tenantId, fiscalMode } } });
     `
     El pr�ximo env�o empezar� una cadena nueva � AEAT aceptar� la factura porque no es duplicada, pero las estad�sticas de correlaci�n se pierden.

### Re-env�o manual

Si la factura se qued� en iscalStatus='rejected' (4xx persistente) o iscalStatus='error' (5xx que agot� reintentos), re-env�ala manualmente:

`ash
curl -X POST https://api.example.com/api/v1/invoices/<invoiceId>/resend-fiscal \
  -H "Authorization: Bearer <tenant-jwt>"
`

Esto rebotea el FiscalService.dispatchInvoice con el mismo hash chain. Si el certificado est� expirado o el NIF es inv�lido, este endpoint tambi�n fallar� � corrige la causa ra�z primero.

### Rollback al modo sin fiscal

Si el tenant quiere dejar de enviar a AEAT temporalmente (ej. certificado en proceso de renovaci�n):

1. PATCH /invoices/settings/fiscal con iscalMode: 'none'.
2. Las facturas existentes siguen emitidas con iscalStatus='accepted' o ejected'. Las facturas futuras tendr�n iscalStatus='not_required'.
3. El hash chain queda pausado. Cuando reactives el modo, las facturas nuevas encadenan desde el �ltimo lastHash conocido.

### Cu�ndo contactar AEAT

Errores persistentes AEAT 400 ... Invalid NIF o Invalid schema despu�s de regenerar el certificado y verificar el NIF con alidateNif suelen requerir un ticket en el portal de pruebas de AEAT. Recopila:
- Invoice.fiscalXml (XML firmado enviado)
- Invoice.fiscalReference (CSV devuelto, si lo hay)
- Invoice.fiscalError (mensaje completo)
- Invoice.fiscalSubmittedAt (timestamp del �ltimo intento)
- Tenant 	axId + 	axIdType

AEAT responde en 24-72h h�biles. Mientras tanto, mant�n la factura en iscalStatus='error'; no la reenv�es.

### Diagn�stico en staging

Para reproducir el caso de un cliente sin necesidad de sandbox AEAT, configura en CI:

`ash
export FISCAL_E2E_MODE=stub      # default; no hace POST
export AEAT_VERIFACTU_ENDPOINT=https://prewww1.aeat.es/wlpl/inwinvoc/ws.Suministro
export NODE_ENV=production      # activa HMAC secret enforcement
`

El e2e/07-fiscal-happy-path.spec.ts corre ambos modos y valida la cadena completa (incluyendo el hash HuellaAnterior propagado al segundo env�o).


## Cutover to AEAT sandbox (P2A Phase 1)

End-to-end procedure to switch from FISCAL_E2E_MODE=stub to the AEAT pre-production portal. Do this only after the production-readiness sprint has shipped (which is the case as of 2026-07-16).

### Pre-requisitos

- AEAT pre-prod account. Register at prewww2.aeat.es with:
  - The Kira software certificate (.p12) � one for the SaaS instance.
  - Issuer NIF for the SaaS (SaaS NIF emisor).
- The first tenant's PKCS#12 already uploaded via /api/v1/invoices/certificates.
- The first tenant's NIF set in Tenant.taxId (SaaS admin endpoint or PATCH /tenants/:id).

### Procedimiento

1. **Activate FISCAL_E2E_MODE=real** in the staging deployment env:

   `ash
   FISCAL_E2E_MODE=real
   AEAT_VERIFACTU_ENDPOINT=https://prewww2.aeat.es/wlpl/inwinvoc/ws.Suministro
   DIPUTACION_TBAI_BIZKAIA=https://prewww.batuz.eus/qqtbai/api/v1/recepcion
   DIPUTACION_TBAI_GIPUZKOA=https://prewww.tbai.gipuzkoa.eus/qrattbai/api/v1/recepcion
   DIPUTACION_TBAI_ALAVA=https://prewww.tbai.araba.eus/qrattbai/api/v1/recepcion
   `

2. **Restart the API service.** This re-reads env and the dispatcher now POSTs to AEAT instead of stubbing.

3. **Run a smoke invoice** through the UI as the tenant owner:
   - Issue 1 invoice (any amount). Wait for iscalStatus='accepted'.
   - Verify the CSV reference appears in Invoice.fiscalReference and on the AEAT pre-prod portal under SuministroLRFacturasEmitidas.
   - Issue a 2nd invoice, confirm <HuellaAnterior> matches the first invoice's iscalHash.
   - Anular the 2nd invoice. Confirm <RegistroAnulacion> is POSTed and iscalStatus='accepted'.

4. **Run e2e/07-fiscal-happy-path.spec.ts against staging** (Playwright with FISCAL_E2E_MODE=real):
   `ash
   cd e2e
   npx playwright test 07-fiscal-happy-path.spec.ts
   `
   The spec was updated in the production-readiness sprint to assert iscalStatus='accepted' for both emission and anulaci�n.

5. **Document the roundtrip in udit_logs:** every dispatch is logged with the response. Confirm at least one entry per regime:
   `sql
   SELECT action, count(*) FROM "audit_logs"
   WHERE action = 'tenant.taxId.change' OR action LIKE '%fiscal%'
   GROUP BY action;
   `

6. **Promote to production** (only after step 3-5 are green for a full week):
   - Replace prewww2.aeat.es with the production endpoint in AEAT_VERIFACTU_ENDPOINT.
   - Update DIPUTACION_TBAI_* to production URLs.
   - Re-run the smoke + e2e against production with a single test tenant. Roll back if iscalError > 5%.

### Pitfalls

- **Clock skew** � XAdES rejects signings where 
otAfter is in the past or > 30 days from now. The CI p12 is valid for 365 days; in production, rotate certificates = 30 days before expiry.
- **Endpoint URL with trailing slash** � AEAT rejects the Suministro action with 401 if the path has a trailing slash. Use the exact URLs above.
- **Time zone** � FiscalChainState.lastSubmittedAt is stored in UTC; AEAT expects FechaExpedicionFactura in Europe/Madrid local time. The dispatcher already does this conversion but if you see "Fecha futura" errors, check the server TZ.
- **HTTPS only** � AEAT will not accept http:// URLs even for testing. The values above are HTTPS.
- **CORS / firewall** � the staging environment must allow outbound 443 to *.agenciatributaria.gob.es and *.batuz.eus.

### Rollback

If the smoke invoice fails, set FISCAL_E2E_MODE=stub and restart. The previous invoice remains in the chain with whatever status it ended up in; you can manually re-issue via POST /invoices/:id/resend-fiscal once the cause is fixed.
