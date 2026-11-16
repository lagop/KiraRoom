/**
 * Content Security Policy for every page, enforced. It ran report-only from
 * October to November 2026 with no violation from a real page; the browser
 * still reports what it blocks to the API (/csp-report), whose log shows a
 * page that needs something the policy forgets.
 *
 * What it limits:
 * - scripts only from the app itself: an injected <script src> from another
 *   host does not load. Inline scripts stay allowed ('unsafe-inline'),
 *   because Next.js bootstraps every page with them; nonces would make
 *   every page dynamic.
 * - connections (fetch, XHR, WebSocket) only to the app and its API, so a
 *   script that does run cannot send the session to another host.
 * - no <base> rewriting, no plugins, forms only to the app.
 *
 * Images may come from any https host or data:/blob: URLs: salons' logos
 * and photos are stored as URLs or data URLs, and the QR codes and the
 * social-media image are drawn in the page.
 *
 * Plain CommonJS, because next.config.js requires it; tested by csp.spec.ts.
 */

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The API's WebSocket origin (live notifications use socket.io): ws: for http:, wss: for https:. */
function socketOriginOf(origin) {
  return origin ? origin.replace(/^http/, 'ws') : null;
}

/**
 * @param {{ apiUrl?: string, dev?: boolean }} opts
 * @returns {string}
 */
/**
 * Cloudflare Turnstile, the captcha on signup, forgot-password and (after
 * failures) login: its script and its iframe come from this origin.
 */
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

function buildCsp({ apiUrl, dev = false } = {}) {
  const api = apiUrl ? originOf(apiUrl) : null;
  const apiSocket = socketOriginOf(api);
  const reportUri = apiUrl ? `${apiUrl.replace(/\/+$/, '')}/csp-report` : null;

  const directives = {
    'default-src': ["'self'"],
    // 'unsafe-eval' only for next dev (React Refresh evaluates modules).
    'script-src': ["'self'", "'unsafe-inline'", TURNSTILE_ORIGIN, ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    // The API, also over WebSocket for live notifications (an http(s)
    // source does not cover ws(s)); next dev reloads over a WebSocket too.
    'connect-src': ["'self'", ...(api ? [api, apiSocket] : []), ...(dev ? ['ws:', 'wss:'] : [])],
    'frame-src': ["'self'", TURNSTILE_ORIGIN],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  };

  const parts = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  if (reportUri) {
    // report-uri for Firefox and Safari; report-to (with the
    // Reporting-Endpoints header) for Chromium, which ignores report-uri
    // when report-to is present.
    parts.push(`report-uri ${reportUri}`, 'report-to csp');
  }
  return parts.join('; ');
}

/**
 * The headers next.config.js adds: `policy` to every page but the booking
 * widget (/embed/*), whose policy middleware.ts sends together with the
 * widget's own frame-ancestors (two enforced policies on one page would both
 * apply, and which of next.config and middleware wins on the same header is
 * not ours to pick); `reporting` to every page.
 */
function cspHeaders({ apiUrl, dev = false } = {}) {
  const policy = { key: 'Content-Security-Policy', value: buildCsp({ apiUrl, dev }) };
  const reporting = apiUrl
    ? [{ key: 'Reporting-Endpoints', value: `csp="${apiUrl.replace(/\/+$/, '')}/csp-report"` }]
    : [];
  return { policy, reporting };
}

/**
 * The page policy plus the widget's frame-ancestors directive when it has
 * one (null: any site may frame it). lib/embed-frame.ts builds and checks
 * that directive.
 */
function withFrameAncestors(policy, frameAncestors) {
  return frameAncestors ? `${policy}; ${frameAncestors}` : policy;
}

module.exports = { buildCsp, cspHeaders, withFrameAncestors };
