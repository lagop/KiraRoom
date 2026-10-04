import { Request } from "express";
import Twilio from "twilio";

/**
 * X-Twilio-Signature check (twilio.com/docs/usage/webhooks/webhooks-security).
 *
 * Twilio signs the full URL it called plus the POST parameters sorted by
 * name, HMAC-SHA1 with the account's auth token. The SDK's validateRequest
 * does exactly that (and copes with the port being present or not), so it
 * is used rather than re-implemented.
 *
 * The URL is the one Twilio saw, not the one Express sees behind Traefik.
 * API_BASE_URL (https://api.kiraroom.net) gives it directly; the request's
 * forwarded protocol and host are the fallback. Trying both is safe: an
 * attacker who controls the Host header still needs the auth token to
 * produce a matching signature.
 */
export function candidateUrls(req: Request, apiBaseUrl?: string): string[] {
  const path = req.originalUrl;
  const urls: string[] = [];
  if (apiBaseUrl) urls.push(apiBaseUrl.replace(/\/+$/, "") + path);
  const host = req.get?.("host");
  if (host) urls.push(`${req.protocol}://${host}${path}`);
  return [...new Set(urls)];
}

export function isValidTwilioRequest(
  req: Request,
  signature: string | undefined,
  authToken: string,
  apiBaseUrl?: string,
): boolean {
  if (!signature) return false;
  const params = req.body && typeof req.body === "object" ? (req.body as Record<string, any>) : {};
  return candidateUrls(req, apiBaseUrl).some((url) =>
    Twilio.validateRequest(authToken, signature, url, params),
  );
}
