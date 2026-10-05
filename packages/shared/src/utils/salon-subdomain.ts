/**
 * Every salon's free address: <slug>.<base>, e.g. salon-lucia.kiraroom.net.
 *
 * Shared by the backend (which says when a salon has one, for the canonical
 * URL, the sitemap and the panel) and the frontend middleware (which serves
 * the salon's page on that host). A slug is usable as a subdomain when it is
 * a valid DNS label and not a name the platform keeps for itself.
 */

/**
 * Names no salon can have as its subdomain: the platform's own hosts, the
 * ones other services on the same server use, and the usual infrastructure
 * names. Explicit DNS records win over the wildcard, so a salon with one of
 * these slugs would never be reached there anyway.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'app', 'api', 'www', 'admin', 'administrador', 'dashboard', 'panel', 'saas',
  'login', 'signup', 'registro', 'auth', 'oauth', 'sso', 'account', 'cuenta',
  'embed', 'sites', 'widget', 'public', 'static', 'assets', 'cdn', 'media', 'img',
  'images', 'files', 'uploads', 'docs', 'help', 'ayuda', 'support', 'soporte',
  'status', 'estado', 'uptime', 'monitor', 'metrics', 'grafana', 'traefik',
  'redirector', 'n8n', 'kairikos', 'portal', 'kiraroom', 'kira', 'blog', 'news',
  'noticias', 'marketing', 'landing', 'web', 'mail', 'email', 'correo', 'smtp',
  'imap', 'pop', 'pop3', 'mx', 'ns', 'ns1', 'ns2', 'dns', 'ftp', 'sftp', 'ssh',
  'vpn', 'autodiscover', 'autoconfig', 'webmail', 'cpanel', 'hpanel', 'billing',
  'facturacion', 'pay', 'payments', 'pagos', 'checkout', 'stripe', 'shop',
  'store', 'tienda', 'webhook', 'webhooks', 'ws', 'wss', 'socket', 'realtime',
  'dev', 'development', 'staging', 'stage', 'test', 'testing', 'demo', 'sandbox',
  'preview', 'beta', 'alpha', 'local', 'localhost', 'internal', 'm', 'mobile',
  'api-docs', 'swagger', 'graphql', 'legal', 'privacy', 'terms', 'reservas',
]);

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A valid DNS label (1-63 lower-case letters, digits or inner hyphens). */
export function isDnsLabel(value: string): boolean {
  return LABEL_RE.test(value);
}

/** Whether this slug can be a salon's subdomain. */
export function isSalonSubdomainSlug(slug: string | null | undefined): boolean {
  const s = (slug ?? '').toLowerCase();
  // An id is a valid label too, but it is not an address anyone shares.
  return isDnsLabel(s) && !RESERVED_SUBDOMAINS.has(s) && !UUID_RE.test(s);
}

/** Normalises "Kiraroom.NET." to "kiraroom.net"; empty when not set. */
export function normaliseSubdomainBase(base: string | null | undefined): string {
  return (base ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

/** "salon-lucia.kiraroom.net", or null when the slug cannot have one. */
export function salonSubdomainHost(slug: string, base: string | null | undefined): string | null {
  const b = normaliseSubdomainBase(base);
  if (!b || !isSalonSubdomainSlug(slug)) return null;
  return `${slug.toLowerCase()}.${b}`;
}

/**
 * The salon slug a host names, when it is <slug>.<base> with a single label
 * in front; null for the base itself, deeper names (a.b.kiraroom.net) and
 * reserved labels (app.kiraroom.net).
 */
export function slugFromSalonSubdomain(host: string, base: string | null | undefined): string | null {
  const b = normaliseSubdomainBase(base);
  if (!b) return null;
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const suffix = `.${b}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  return label && !label.includes('.') && isSalonSubdomainSlug(label) ? label : null;
}
