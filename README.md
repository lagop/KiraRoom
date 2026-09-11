# KiraRoom — SaaS Platform for Beauty Salons

A multi-tenant SaaS for beauty salons, spas, and barbershops. Covers the
full operator workflow (appointments, clients, inventory, billing) plus
a team-side AI assistant (Kira Copilot) for salon staff.

## What's in the box

### Operator-facing (the customer's customer)

- **Appointments** — multi-service booking with calendar, conflicts, and reminders
- **Clients** — history, tags, consent, marketing preferences
- **Services + Products** — catalog with prices, durations, stock tracking
- **POS** — point of sale with cart and checkout
- **Billing** — invoices, fiscal compliance (AEAT/M303/M130/KMS), Stripe + Holded + Sage
- **Loyalty + Gift Cards + Promotions** — retention toolkit
- **WhatsApp + SMS + Email campaigns** — multi-channel client outreach
- **Rebooking + No-show tracking** — keeps the chair full
- **Reviews** — Google Reviews auto-pull + manual moderation
- **Multi-location** — multi-salon chains with consolidated reporting
- **Multi-language / multi-currency** — ES + EN out of the box

### Team-facing (Kira Copilot)

The in-app AI assistant for salon staff. Opens via a slide-over panel
in the dashboard. Plan-gated:

- **Pro tier** — 8 read tools (agenda, client 360, top clients, low
  stock, no-shows, wait-list, gap-filling) + daily briefing card.
- **Premium / Empresa tier** — also 6 write tools, every action gated
  behind human approval (move appointment, draft WhatsApp, send
  WhatsApp, mark no-show, create coupon, notify wait-list).

See [`docs/staff-copilot-guide.md`](docs/staff-copilot-guide.md) for the
staff guide, [`docs/admin-copilot-guide.md`](docs/admin-copilot-guide.md)
for the admin guide, [`docs/saas-copilot-runbook.md`](docs/saas-copilot-runbook.md)
for the platform-team runbook.

## Repository layout

```
KiraRoom/
├── packages/
│   ├── backend/       # NestJS + Prisma + PostgreSQL
│   ├── frontend/      # Next.js (App Router) for the customer dashboard
│   ├── shared/        # Zod DTOs shared between backend + frontend
│   └── marketing/     # Astro site (public landing + signup)
├── docs/              # RFCs, guides, runbooks, security reviews
├── scripts/           # one-off maintenance scripts
├── docker/            # init scripts for the dev DB
├── ops/               # grafana dashboards, monitoring
├── e2e/               # shared Playwright fixtures
├── .github/workflows/ # CI/CD pipeline (lint + L4 + L1 e2e + Docker)
└── docker-compose*.yml
```

## Branching model

We run a slim **git-flow** tailored for a small SaaS team:

| Branch | Purpose | Deploys to |
|---|---|---|
| `main` | Production. Protected, PR-only, requires green CI. | Hostinger Docker Manager, `app/api/admin.kiraroom.net` (closed-beta gate; see Status below) |
| `develop` | Integration. Features land here first via PR. | CI builds the Docker images (smoke test only — no push); deploys happen via hPanel after merging to `main`. |
| `feat/<name>` | Short-lived (1-5 days). Off `develop`. Rebase before merge. | — |
| `hotfix/<name>` | Off `main`, fast-merge back. For security + incidents. | Production hotfix |

Soft-launch controls (sprint 16) — close to GA:

```bash
# .env (backend) — only listed tenant IDs can access Kira Copilot.
# Empty = GA mode; non-empty = closed-beta whitelist.
COPILOT_SOFT_LAUNCH_TENANT_IDS=tenant_a,tenant_b,tenant_c
```

## Quickstart (local dev)

```bash
# 1. Postgres
docker compose up -d postgres

# 2. Backend
cd packages/backend
cp .env.example .env
npm ci
npx prisma migrate deploy
npm run dev               # http://localhost:3001

# 3. Frontend (new terminal)
cd packages/frontend
npm ci
npm run dev               # http://localhost:3000

# 4. Marketing site (optional)
cd packages/marketing
npm ci
npm run dev
```

## Production deployment

KiraRoom is deployed via **Hostinger Docker Manager** using the docker-compose URL flow. No CI deploy step, no GHCR, no SSH required.

```bash
# 1. Merge your changes to `main` (via PR — branch protection enforces this).
# 2. Open Hostinger hPanel -> VPS -> Docker Manager -> Compose -> URL.
# 3. Paste:
https://raw.githubusercontent.com/lagop/KiraRoom/main/docker-compose.prod.yml
# 4. Click Deploy. Enter env vars for backend + nginx from .env.production.example.
# 5. Visit http://<vps-ip>:3000 (frontend) and :3001/api/v1/ping (backend) to smoke test.
```

Every subsequent deploy is the same: merge to `main`, redeploy in hPanel.

For DNS + HTTPS, see [docs/runbook.md](docs/runbook.md) "Deploy flow" and "Failure: TLS certificate expires".

### Required env vars (production)

| Var | Notes |
|---|---|
| `JWT_SECRET` | **≥ 32 random chars.** SEC-1 refuses to boot otherwise. Generate with `openssl rand -base64 48`. |
| `DATABASE_URL` | Postgres connection string |
| `MINIMAX_API_KEY` | **Primary LLM provider key.** MiniMax is the Anthropic-API-compatible gateway used as the default for the virtual receptionist and Staff Copilot. `MINIMAX_BASE_URL` overrides the gateway URL (leave blank for the public endpoint). |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe payments. SEC-3 refuses to boot when `STRIPE_SECRET_KEY` is set but `STRIPE_WEBHOOK_SECRET` is missing in production. |
| `META_TOKEN_ENCRYPTION_KEY` | AES key for Meta access tokens (≥ 32 chars) |
| `OAUTH_STATE_SECRET` | **≥ 16 random chars.** Boot validator refuses to start in production without it. Generate with `openssl rand -base64 48`. |
| `CORS_ALLOWED_ORIGINS` | Comma-separated exact origins. **No wildcards.** |
| `NODE_ENV` | Must be `production` |
| `COPILOT_SOFT_LAUNCH_TENANT_IDS` | Optional. Whitelist for closed-beta. Empty = Kira Copilot off for everyone. |
| `FISCAL_MODE` | `sandbox` until the AEAT cert is uploaded and `docs/runbook.md` §11 signed off; flip to `real` only after. |

### Secondary LLM providers (optional)

The LLM service also accepts OpenAI, Anthropic, and Google Gemini keys for fallback / per-tenant overrides. Set whichever you have; unset keys are silently skipped. See `ops/deploy/.env.production.example` for the full list.

Full env template: `packages/backend/.env.example`.

## Testing

| Layer | Command | When |
|---|---|---|
| Lint | `npx eslint src packages` (backend) / `npx eslint app components lib src` (frontend) | Every PR |
| Type-check | `npx tsc --noEmit` | Every PR |
| L4 unit | `npm test -- --testPathPattern=l4` | Every PR (CI gates on this) |
| L1 e2e (real LLM) | `RUN_LLM_E2E_TESTS=1 MINIMAX_API_KEY=... npm test -- --testPathPattern=co-pilot-scenarios.spec` | Manual dispatch in CI (see `.github/workflows/ci-cd.yml`) |
| Playwright UX | `npx playwright test` | TODO — see RFC §15.2 |

## Documentation

| Doc | Audience |
|---|---|
| [`docs/staff-copilot-guide.md`](docs/staff-copilot-guide.md) | Salon staff using the assistant |
| [`docs/admin-copilot-guide.md`](docs/admin-copilot-guide.md) | Salon owners / managers |
| [`docs/saas-copilot-runbook.md`](docs/saas-copilot-runbook.md) | Platform team (kill switches, alerts, debug) |
| [`docs/staff-copilot-changelog.md`](docs/staff-copilot-changelog.md) | Sprint-by-sprint delivery log |
| [`docs/professional-copilot-rfc.md`](docs/professional-copilot-rfc.md) | Original RFC — now `Implemented (sprint 12-16, GA-ready)` |
| [`docs/runbook.md`](docs/runbook.md) | Production ops |
| [`docs/saas-admin-runbook.md`](docs/saas-admin-runbook.md) | Tenant management |
| [`docs/security-review-2026-07.md`](docs/security-review-2026-07.md) | Self-review + open backlog (SEC-1 + SEC-2 closed) |
| [`docs/final-roadmap-tracker.md`](docs/final-roadmap-tracker.md) | Tax-compliance phases (all ✅ done) |

## Status

| Area | Status |
|---|---|
| Tax compliance (AEAT / KMS / PDF / Holded / Sage) | ✅ shipped |
| Customer chatbot (virtual receptionist) | ✅ shipped |
| Staff copilot (sprints 12-16) | ✅ shipped, soft-launch active |
| Self-review security backlog | ✅ SEC-1, SEC-2, SEC-3, SEC-4 closed (SEC-5 pen-test deferred until €500 MRR × 2 months) |
| OAUTH_STATE_SECRET boot validator | ✅ shipped (prevents prod deploys shipping the controller's dev fallback) |
| Production deploy infra (Hostinger Docker Manager + `docker-compose.prod.yml`) | ✅ code-ready; awaiting operator: paste URL into hPanel + fill env vars |
| Sprint 17 — closed beta | 🟡 infrastructure ready, blocked on operator: VPS bootstrap, DNS, `.env.production`, branch protection on `main` |
| Sprint 18+ — open rollout | Not started (depends on closed-beta results + SEC-5 pen-test) |

## License

Proprietary. © Kira Room.
