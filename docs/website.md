# The public websites

There are three things that look like "the website". Only the first one is what
people see when they search for KiraRoom.

| Address | What it is | Where its code lives | How it is published |
|---|---|---|---|
| `https://kiraroom.com` | The commercial site: one static page (plans, calculator, FAQ). | The **private** repository `lagop/kiraroom-landing` (plain HTML, CSS and JS, no build step). | Automatically: Hostinger hPanel is connected to that repository (hPanel > Git) and publishes `main` to the hosting. A push to `main` is the release. |
| `https://app.kiraroom.net/` | The app's own landing page: header, features, plans loaded from the API, links to sign up and log in. `kiraroom.net` redirects here. | `packages/frontend/app/page.tsx` and the `landing.*` keys in `packages/frontend/messages/es.json` and `en.json`. | Like the rest of the app (the frontend image, see `docs/runbook.md`). |
| `marketing/` in this repo | An old Astro site. **Not published anywhere.** The domain it points to does not resolve and no CI step builds it. | This repo, `marketing/`. | Never. See the note at the top of `marketing/README.md`. Whether to delete it is a pending decision. |

The legal pages are not on kiraroom.com. They live in the app and kiraroom.com
links to them: `https://app.kiraroom.net/legal/privacy` and `/legal/terms`
(code: `packages/frontend/app/legal/`; `docs/privacy.md` and `docs/tos.md` only
point there). The price list for people who are not logged in is
`https://kiraroom.com/#precios`; the terms link to it.

## Plans and prices must be the same everywhere

One source: `packages/shared/src/types/subscription.ts` (`PLAN_PRICES`,
`PLAN_FEATURES`, `PLAN_MAX_PROFESSIONALS`, `PLAN_AI_CONVERSATIONS`, ...).
The backend catalogue (what Stripe charges), the app (billing screen, landing,
upgrade prompts) and the SaaS console read it. Prices carry no VAT/IGIC on top:
they are the final price, and every text says so ("precio final, sin impuestos
añadidos").

kiraroom.com has its own copy of the numbers, typed by hand in its HTML and in
`script.js` (the calculator). Nothing in CI can see that repository, so these
guards exist:

| Guard | What it protects | Runs |
|---|---|---|
| TypeScript imports from `@kira/shared` | backend, frontend and console cannot disagree with the catalogue | every build |
| `packages/backend/src/payments/plan-catalog-drift.l4.spec.ts` | the matrix and the billed prices equal the shared ones; also the JSON in `marketing/` (which is not published, see above) | CI |
| `packages/frontend/lib/salon-legal.spec.ts` | the privacy page and the terms do not claim what the code does not do (no Sage/A3/NCS, WAF, WAL...), list the sub-processors, link the public price list | CI |
| `packages/backend/src/auth/signup-audit.spec.ts` | the terms page date equals `TERMS_VERSION` | CI |
| `scripts/check-public-site.mjs` | the **live** kiraroom.com against the shared catalogue, its mailto addresses and its links | by hand, weekly |

### The weekly check

Needs node 18 or newer and the network. It is not part of CI.

```bash
node scripts/check-public-site.mjs                   # https://kiraroom.com/
node scripts/check-public-site.mjs https://example/  # another address (a staging copy)
node scripts/check-public-site.mjs --html page.html  # a saved copy; links are not fetched
```

It reads the prices, the professionals per plan and the AI messages per plan
from `packages/shared/src/types/subscription.ts` and fails, with a list, if the
page contains `hola@` or "IVA no incluido", has a `mailto:` other than
`info@kiraroom.com` or `admin@kiraroom.net`, has a link that does not end in
200 (or an `#anchor` with no matching id), or shows a price, a professional
limit or an AI message cap different from the catalogue. Exit code 0 is good,
1 means problems, 2 means the page could not be read. Run it every Monday and
after every change to the site or to the catalogue.

## Checklist: changing the public site

1. Edit `lagop/kiraroom-landing` (not `marketing/`). Open the page locally.
2. If you touch a price, plan limit, channel or feature: change
   `packages/shared/src/types/subscription.ts` **first** (that is a PR here, with
   the drift test), then copy the numbers into the landing HTML and into
   `script.js` (calculator). The text under the prices says "Precio final, sin
   impuestos añadidos".
3. Contact is `info@kiraroom.com` only. `admin@kiraroom.net` is internal. Do not
   add other mailboxes: they do not exist.
4. Say only what works today. If a channel (WhatsApp, Messenger, Instagram,
   Telegram) or a plan feature is not live for a real salon, do not sell it.
   Check `packages/shared` for which plan has SMS, campaigns and so on.
5. Keep the data promise equal to the terms: 30 days read-only after the end,
   personal data anonymised at 60 days in total, fiscal data kept
   (`packages/backend/src/saas/retention/salon-retention.ts`).
6. Keep the footer links to the privacy policy and the terms (app.kiraroom.net)
   and to the price list; do not add third-party scripts, fonts or images
   without adding them to the privacy policy first.
7. Push to `main`. Hostinger publishes it; wait a minute, then run
   `node scripts/check-public-site.mjs`.
8. If you changed the terms or the privacy page in this repo, also update the
   "Última actualización" date and `TERMS_VERSION` (`signup-audit.spec.ts`
   fails otherwise), and remember the terms promise 30 days' notice of
   material changes to salons.

## Things that are easy to get wrong

- Static assets of the landing may be cached by browsers for days after a
  publish; rename or version a changed CSS/JS file.
- `www.kiraroom.com` serves the same page as `kiraroom.com` without redirecting;
  decide the canonical address before working on search engines.
- The 404 page of kiraroom.com is Hostinger's default until the landing
  repository adds its own `404.html`.
