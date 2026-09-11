# KiraRoom marketing site

Static, zero-JS marketing site built with [Astro](https://astro.build)
and hosted on [Cloudflare Pages](https://pages.cloudflare.com). Part of
Sprint 2 / Workstream 2.4 of the
[zero-budget launch roadmap](../../.local/share/kilo/plans/1784285888087-zero-budget-launch-roadmap.md).

## Stack

- **Astro 4** — static output, zero JS by default
- **Cloudflare Pages** — free tier (unlimited bandwidth, unlimited requests)
- **No framework, no Tailwind** — single hand-rolled stylesheet at `src/styles/global.css`
- **One hand-rolled favicon** at `public/favicon.svg`

Total bundle weight (gzipped, post-build): < 5 KB per page.

## Pages

| Route | Purpose |
|---|---|
| `/` | Home — hero, three-feature pitch, pricing summary, CTA |
| `/pricing` | Full pricing table + FAQ |
| `/privacy` | Privacy policy (AEPD template) |
| `/tos` | Terms of service |
| `/login` | One-hop redirect to `https://app.kiraroom.com/login` |

All copy is in Spanish. The customer is Spanish — localization is part
of the brand, not a feature toggle.

## Local development

```bash
cd marketing
npm install
npm run dev          # http://localhost:4321
npm run type-check   # astro check (Astro type validation)
```

## Build

```bash
npm run build        # → dist/
npm run preview      # local preview of the built site
```

Output is fully static; no Node.js runtime required in production.

## Deploy to Cloudflare Pages

### One-time setup

```bash
# Install wrangler (already in devDependencies)
npx wrangler login

# Create the Pages project
npx wrangler pages project create kiraroom-marketing \
  --production-branch main \
  --compatibility-date 2024-09-23
```

### Option A — Git integration (recommended)

1. In the Cloudflare dashboard → Pages → your project → Settings → Builds:
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** `marketing`
   - **Node version:** 20
2. Push to `main` → automatic deploy.

### Option B — CLI from workstation

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
npm run deploy
```

### Custom domains

Configure in Cloudflare dashboard → Pages → `kiraroom-marketing` → Custom domains:

- `marketing.kiraroom.com` → this Pages project

The SaaS dashboard continues to live at `app.kiraroom.com` (existing
Hetzner VPS or current host). Apex `kiraroom.com` can stay on
whichever registrar — only the subdomains need Cloudflare proxying.

## Environment variables

| Variable | Where | Required |
|---|---|---|
| `PUBLIC_APP_URL` | Cloudflare Pages dashboard → Settings → Environment variables | yes (defaults to `https://app.kiraroom.com`) |

Only `PUBLIC_*` vars are exposed to the client bundle. No secrets.

## Why no Tailwind / framework?

Cloudflare Pages free tier covers unlimited bandwidth, but bundle size
directly affects TTFB on slow connections (Spanish mobile networks).
A single 3 KB CSS file + ~0 KB JS is faster than any framework bundle
and trivial to maintain for a five-page site. If the marketing surface
grows beyond ~15 pages, revisit this decision.

## Production hardening

The marketing site ships with the following production-grade defaults
(no extra cost, no extra runtime services):

| File | Purpose |
|---|---|
| `public/_headers` | Cloudflare Pages reads this and merges with every response. Sets HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, CSP, COOP/CORP/COEP. |
| `public/robots.txt` | Allows everything except `/login` (one-hop redirect). Points at `sitemap-index.xml`. |
| `public/og-image.svg` | Open Graph / Twitter Card preview image (1200×630, no raster assets). Linked via `<meta property="og:image">` and `<meta name="twitter:image">` in `BaseLayout.astro`. |
| `public/cookie-banner.js` | Vanilla-JS LSSI Art. 22.2 / RGPD cookie consent banner. Four categories (necessary / preferences / analytics / marketing), persistent floating pill for withdrawal, dispatches `kiraroom:consent-changed` CustomEvent on save. |
| `src/styles/global.css` (cookie banner section) | Styles for the dialog + floating pill. Mobile breakpoint at 600 px. |
| Cloudflare Web Analytics | Activated by setting `PUBLIC_CF_ANALYTICS_TOKEN` env var. The beacon script is **inert by default** — it is injected into `<head>` only after the user opts in to "Analítica". Zero cookies, no fingerprinting, EU-only servers. |

## LSSI / RGPD compliance notes

The marketing site displays a cookie consent banner on the first visit
as required by **Ley 34/2002 (LSSI) Art. 22.2** and the GDPR. The banner:

- Explicit consent (no pre-checked boxes for non-necessary categories).
- Granular per-category opt-in (preferences / analytics / marketing).
- Persistent — closing the dialog without choosing leaves the user in
  the same state as before the visit.
- Persistent withdrawal mechanism — the floating "🍪 Configurar"
  pill reopens the dialog at any time.
- Mirrors the storage shape (`kira-cookie-consent-v2`) and event
  shape (`kiraroom:consent-changed`) of the frontend's React banner
  so user choice is consistent across both surfaces.

The privacy policy (`/privacy`) is auto-generated by
`scripts/legal-sync.ts` from the canonical `.tsx` source.

## License

MIT (project root) — applies to this subdirectory.