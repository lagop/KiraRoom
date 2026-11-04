import { Injectable, Logger } from "@nestjs/common";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 5_000;

export type TurnstileOutcome = "ok" | "missing" | "failed";

/**
 * Cloudflare Turnstile, checked on the server: signup, forgot-password and,
 * after 3 failed sign-ins, login.
 *
 * Off until TURNSTILE_SECRET_KEY is set (and the frontend image is built with
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY): with no secret every check passes, so
 * nothing changes for a deploy without the keys. Set both together; a
 * secret without a site key would refuse every signup, because the forms
 * would have no widget to answer it.
 *
 * Cloudflare saying no fails the check. Cloudflare not answering (timeout,
 * network) lets it through with a warning: an outage on their side must not
 * stop salons from signing up, and the per-IP and per-domain limits still
 * apply.
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  /** Whether the captcha is configured at all. */
  isEnabled(): boolean {
    return Boolean((process.env.TURNSTILE_SECRET_KEY ?? "").trim());
  }

  async verify(token: string | undefined | null, remoteIp?: string | null): Promise<TurnstileOutcome> {
    const secret = (process.env.TURNSTILE_SECRET_KEY ?? "").trim();
    if (!secret) return "ok";
    const response = (token ?? "").trim();
    if (!response) return "missing";

    const body = new URLSearchParams({ secret, response });
    if (remoteIp) body.set("remoteip", remoteIp);
    try {
      const res = await fetch(SITEVERIFY_URL, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(`Turnstile siteverify answered ${res.status}; letting the request through`);
        return "ok";
      }
      const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
      if (data.success === true) return "ok";
      this.logger.log(`Turnstile refused a token: ${(data["error-codes"] ?? []).join(",") || "no reason"}`);
      return "failed";
    } catch (err) {
      this.logger.warn(`Turnstile siteverify unreachable (${(err as Error).message}); letting the request through`);
      return "ok";
    }
  }
}

/** What the forms show when the check is missing or failed. */
export const CAPTCHA_MESSAGE = "Confirma que no eres un robot y vuelve a intentarlo.";

/** Machine-readable code the login form uses to show the widget. */
export const CAPTCHA_REQUIRED_CODE = "CAPTCHA_REQUIRED";
