import * as fs from 'fs';
import * as path from 'path';

/**
 * Drift guard between the operator's environment template and the
 * production compose file.
 *
 * Compose does not pass the deploy environment through to a container:
 * a variable reaches the backend only if it is listed in that service's
 * `environment:` block. The two files silently disagreed -- 11 variables
 * forwarded against 54 documented -- so most of what the operator set in
 * Hostinger was dead config. The visible failure was login
 * ("Failed to fetch"): CORS_ALLOWED_ORIGINS never arrived and the
 * allow-list fell back to http://localhost:3000. Along with it went
 * e-mail, Sentry, SMS and the Meta webhook signature check, none of which
 * announce themselves when unconfigured.
 *
 * Nothing in the build could catch that, because neither file is code.
 * This spec makes the disagreement a test failure.
 *
 * Two directions are checked:
 *   1. Everything the template documents is forwarded, or listed below
 *      with a reason. A new variable in the template fails until it is
 *      one or the other.
 *   2. Everything the compose requires without a default is documented,
 *      so the operator can know to set it. REBOOKING_OPT_OUT_SECRET was
 *      required by the compose and appeared nowhere in the template.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMPOSE = path.join(REPO_ROOT, 'docker-compose.prod.yml');
const TEMPLATE = path.join(REPO_ROOT, 'ops', 'deploy', '.env.production.hostinger');

/**
 * Documented variables that must NOT reach the backend container, each
 * for a stated reason. Anything here is a deliberate exclusion, not an
 * oversight -- the whole point of the list is that the two cases stop
 * looking alike.
 */
const NOT_BACKEND_CONFIG: Record<string, string> = {
  // Dev/test escape hatches. Forwarding them would let a stray value in
  // the deploy environment disable the startup security validators
  // (see startup-checks.ts).
  ALLOW_WEAK_JWT_SECRET: 'dev escape hatch; must never reach production',
  ALLOW_WEAK_OAUTH_STATE_SECRET: 'dev escape hatch; must never reach production',
  ALLOW_UNVERIFIED_STRIPE_WEBHOOK: 'dev escape hatch; must never reach production',

  // Baked into the frontend bundle as build args (packages/frontend/Dockerfile).
  NEXT_PUBLIC_API_URL: 'frontend build arg, not backend runtime config',
  NEXT_PUBLIC_WS_URL: 'frontend build arg, not backend runtime config',

  // Consumed by the deploy tooling, not by the app.
  REGISTRY: 'read by ops/deploy scripts',
  IMAGE_NAMESPACE: 'read by ops/deploy scripts',
  IMAGE_TAG: 'read by ops/deploy scripts (and forwarded as SENTRY_RELEASE)',

  // Passed ad hoc on the first-deploy seed command, so the platform
  // owner password is not resident in every container's environment.
  SAAS_OWNER_EMAIL: 'passed ad hoc to the seed command',
  SAAS_OWNER_PASSWORD: 'passed ad hoc to the seed command',

  // Consumed by other services in the same compose file.
  POSTGRES_PASSWORD: 'used to build DATABASE_URL; postgres service reads it directly',
  BACKUP_RETENTION_DAYS: 'read by the postgres-backup service',

  // Documented but read by no backend source file. Left documented
  // because the deploy references them, but they are not forwarded.
  API_BASE_URL: 'documented for the operator; no backend source reads it',
  GOOGLE_AI_API_KEY: 'no backend source reads this name',
};

function readFileOrFail(p: string): string {
  if (!fs.existsSync(p)) {
    throw new Error(
      `${path.relative(REPO_ROOT, p)} is missing. This spec guards the deploy ` +
        'configuration; if the file moved, update the path here too.',
    );
  }
  return fs.readFileSync(p, 'utf8');
}

/** Keys of the form `KEY=value` in the operator template. */
function documentedKeys(): string[] {
  return (readFileOrFail(TEMPLATE).match(/^[A-Z][A-Z0-9_]*(?==)/gm) ?? []).sort();
}

/** The backend service's `environment:` keys. */
function forwardedToBackend(): string[] {
  const compose = readFileOrFail(COMPOSE);
  const start = compose.indexOf('\n  backend:');
  expect(start).toBeGreaterThan(-1);
  const block = compose.slice(start, compose.indexOf('\n    depends_on:', start));
  const envStart = block.indexOf('\n    environment:');
  expect(envStart).toBeGreaterThan(-1);
  return (block.slice(envStart).match(/^ {6}([A-Z][A-Z0-9_]*):/gm) ?? [])
    .map((line) => line.trim().replace(':', ''))
    .sort();
}

/**
 * `${VAR}` references with no `:-` fallback, anywhere in the compose.
 * These have no default, so an undocumented one is a variable the
 * operator cannot know to set.
 *
 * `$${VAR}` is skipped: the doubled `$` escapes the substitution, leaving
 * a literal `${VAR}` for the container's own shell. The postgres-backup
 * entrypoint uses that for its loop variables, which are not deploy
 * configuration at all.
 */
function requiredWithoutDefault(): string[] {
  const compose = readFileOrFail(COMPOSE);
  const refs = new Set<string>();
  for (const m of compose.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)\}/g)) refs.add(m[1]);
  return [...refs].sort();
}

describe('deploy: the env template and the production compose agree', () => {
  it('forwards every documented variable to the backend, or excludes it on purpose', () => {
    const forwarded = new Set(forwardedToBackend());
    const unaccounted = documentedKeys().filter(
      (k) => !forwarded.has(k) && !(k in NOT_BACKEND_CONFIG),
    );

    expect(unaccounted).toEqual([]);
  });

  it('documents every variable the compose requires without a default', () => {
    const documented = new Set(documentedKeys());
    const undocumented = requiredWithoutDefault().filter((k) => !documented.has(k));

    // REBOOKING_OPT_OUT_SECRET was exactly this: required by the compose,
    // absent from the template, so the deploy ran with it empty.
    expect(undocumented).toEqual([]);
  });

  it('never forwards a dev escape hatch to the backend container', () => {
    const forwarded = forwardedToBackend();
    const leaked = forwarded.filter(
      (k) => k.startsWith('ALLOW_WEAK_') || k.startsWith('ALLOW_UNVERIFIED_'),
    );

    expect(leaked).toEqual([]);
  });

  it('forwards the variables whose absence broke production, specifically', () => {
    const forwarded = new Set(forwardedToBackend());

    // CORS_ALLOWED_ORIGINS is what broke login; the rest fail silently,
    // which is worse. Pinned by name so a reorganisation of the compose
    // cannot quietly drop them.
    for (const key of [
      'CORS_ALLOWED_ORIGINS',
      'APP_BASE_URL',
      'FRONTEND_URL',
      'FRONTEND_BASE_URL',
      'JWT_REFRESH_SECRET',
      'RESEND_API_KEY',
      'EMAIL_FROM',
      'SENTRY_DSN',
      'META_APP_SECRET',
      'METRICS_SCRAPE_TOKEN',
    ]) {
      expect(forwarded).toContain(key);
    }
  });

  it('gives every exclusion a reason', () => {
    for (const [key, reason] of Object.entries(NOT_BACKEND_CONFIG)) {
      expect(reason.length).toBeGreaterThan(10);
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('keeps no stale exclusions for variables the template dropped', () => {
    const documented = new Set(documentedKeys());
    const stale = Object.keys(NOT_BACKEND_CONFIG).filter((k) => !documented.has(k));

    // An exclusion that no longer matches anything is a reason nobody can
    // check. GOOGLE_BUSINESS_CLIENT_ID/_SECRET were excluded here and then
    // removed from the template once it became clear the code reads
    // GOOGLE_CLIENT_ID/GOOGLE_REDIRECT_URI instead.
    expect(stale).toEqual([]);
  });
});
