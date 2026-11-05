import { Body, Controller, HttpCode, HttpStatus, Logger, Post } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/decorators/public.decorator";
import { CspViolation, parseCspReport } from "./csp-report";

/** Repeats of one violation are logged once per window, so a busy page cannot flood the log. */
const REPEAT_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED = 500;

/**
 * Receives the browsers' Content Security Policy reports (see
 * packages/frontend/csp.js) and writes each distinct violation to the log
 * as a warning. While the policy is report-only, that log is how we learn
 * whether enforcing it would break a real page.
 */
@ApiExcludeController()
@Controller("csp-report")
export class CspReportController {
  private readonly logger = new Logger("CspReport");
  private readonly lastLogged = new Map<string, number>();

  @Public()
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  receive(@Body() body: unknown): void {
    const now = Date.now();
    for (const v of parseCspReport(body)) {
      if (!this.firstInWindow(v, now)) continue;
      this.logger.warn(
        `CSP ${v.disposition === "enforce" ? "blocked" : "would block"} ${v.directive}: ` +
          `${v.blocked || "(no URL)"} on ${v.page || "(unknown page)"}${v.source ? ` from ${v.source}` : ""}`,
      );
    }
  }

  private firstInWindow(v: CspViolation, now: number): boolean {
    const key = `${v.directive}|${v.blocked}|${v.page}`;
    const last = this.lastLogged.get(key);
    if (last !== undefined && now - last < REPEAT_WINDOW_MS) return false;
    if (this.lastLogged.size >= MAX_TRACKED) {
      for (const [k, t] of this.lastLogged) if (now - t >= REPEAT_WINDOW_MS) this.lastLogged.delete(k);
      if (this.lastLogged.size >= MAX_TRACKED) this.lastLogged.clear();
    }
    this.lastLogged.set(key, now);
    return true;
  }
}
