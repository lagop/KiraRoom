/**
 * The panel's public address, for the links in emails: APP_BASE_URL, else
 * FRONTEND_URL, else https://app.kiraroom.net (the app's domain; the old
 * fallback, app.kiraroom.com, is another domain). No trailing slash.
 *
 * `get` reads a setting: pass ConfigService.get where there is one;
 * without it, the process environment is read.
 */
export const DEFAULT_APP_BASE_URL = "https://app.kiraroom.net";

export function appBaseUrl(
  get: (key: string) => string | undefined | null = (key) => process.env[key],
): string {
  const value = get("APP_BASE_URL")?.trim() || get("FRONTEND_URL")?.trim() || DEFAULT_APP_BASE_URL;
  return value.replace(/\/+$/, "");
}
