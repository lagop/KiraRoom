import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { EmailService } from "../notifications/services/email.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { RedisService } from "../common/cache/redis.service";

interface BugReportInput {
  subject: string;
  description: string;
  currentUrl?: string;
  appVersion?: string;
  /** The email typed in the modal; only stored when there is no session. */
  email?: string;
  context?: Record<string, unknown>;
  /** Auto-attached by the global JWT guard when the user is logged in. */
  tenantId?: string | null;
  authorId?: string | null;
  /** The signed-in account's own address: the only one that gets the acknowledgement. */
  accountEmail?: string | null;
}

const HOUR = 3600;

/**
 * Reports one sender can file. Each report emails the founder and the
 * reporter, so without a cap the form became a way to send KiraRoom mail at
 * volume and use up the email quota every salon relies on. The route also has
 * a per-IP @Throttle (in memory); these counters are in Redis.
 */
export const BUG_REPORT_LIMITS = {
  perUserPerHour: 5,
  perTenantPerHour: 10,
} as const;

export const TOO_MANY_BUG_REPORTS =
  "Has enviado varios reportes seguidos. Espera un poco antes de mandar otro.";

/**
 * Bug-report ingest service. Persists the report as a `BugReport` row
 * (visible in the SaaS admin dashboard) and forwards a copy via the
 * existing `EmailService` to the founder.
 *
 * The "founder email" is read from `FOUNDER_EMAIL` env var (default:
 * `admin@kiraroom.net`). When unset (early dev), the report is
 * logged to stdout instead.
 *
 * When the reporter is signed in, an automated acknowledgement goes to their
 * account's own email with the report's id as the tracking id (the same id
 * the console shows). Reports without a session get no acknowledgement.
 */
@Injectable()
export class BugReportService {
  private readonly logger = new Logger(BugReportService.name);

  constructor(
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Counts one report against the sender's hourly limits; throws 429 once over. */
  private async checkLimits(input: BugReportInput): Promise<void> {
    if (input.authorId) {
      const n = await this.redis.increment(`bug-report:user:${input.authorId}`, HOUR);
      if (n > BUG_REPORT_LIMITS.perUserPerHour) {
        throw new HttpException(TOO_MANY_BUG_REPORTS, HttpStatus.TOO_MANY_REQUESTS);
      }
    }
    if (input.tenantId) {
      const n = await this.redis.increment(`bug-report:tenant:${input.tenantId}`, HOUR);
      if (n > BUG_REPORT_LIMITS.perTenantPerHour) {
        throw new HttpException(TOO_MANY_BUG_REPORTS, HttpStatus.TOO_MANY_REQUESTS);
      }
    }
  }

  async submit(input: BugReportInput): Promise<string> {
    await this.checkLimits(input);

    // The row's own id, so the tracking id in the acknowledgement is one the
    // console can find.
    const id = randomUUID();
    const recipient = process.env.FOUNDER_EMAIL ?? "admin@kiraroom.net";
    const reporterEmail = input.accountEmail ?? input.email ?? null;

    const body = [
      `Subject: ${input.subject}`,
      "",
      input.description,
      "",
      "--- Context ---",
      `URL:        ${input.currentUrl ?? "(not provided)"}`,
      `App:        ${input.appVersion ?? "(not provided)"}`,
      `Reporter:   ${reporterEmail ?? "(anonymous)"}`,
      `Submitted:  ${new Date().toISOString()}`,
      `Tracking:   ${id}`,
      "",
      "--- Raw context payload ---",
      JSON.stringify(input.context ?? {}, null, 2),
    ].join("\n");

    // Persist first so the row exists even if the email transport is
    // down. The DB is the durable record; email is a notification.
    try {
      await this.prisma.bugReport.create({
        data: {
          id,
          tenantId: input.tenantId ?? null,
          authorId: input.authorId ?? null,
          subject: input.subject,
          description: input.description,
          currentUrl: input.currentUrl ?? null,
          appVersion: input.appVersion ?? null,
          email: reporterEmail,
          context: (input.context ?? {}) as any,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to persist bug report (id=${id}): ${(err as Error).message}`,
      );
      // Fall through — email still gets sent so the report isn't lost.
    }

    try {
      // sendEmail reports a failure in its result instead of throwing, so
      // the log used to say "accepted" for a notice that never left (D13).
      const sent = await this.email.sendEmail({
        to: recipient,
        subject: `[KiraRoom bug] ${input.subject} (${id.slice(0, 8)})`,
        html: `<pre style="font-family: ui-monospace, monospace; white-space: pre-wrap;">${escapeHtml(body)}</pre>`,
      });
      if (sent && sent.success === false) {
        this.logger.warn(`Bug report ${id} saved, but its notice to ${recipient} was not sent: ${sent.error ?? "unknown error"}`);
      } else {
        this.logger.log(`Bug report accepted: id=${id}`);
      }
    } catch (err) {
      // The transport may not be wired in dev. Fall back to stdout
      // so the report isn't lost — the founder can grep logs.
      this.logger.warn(
        `Bug report (id=${id}, recipient=${recipient} failed to email: ${(err as Error).message}). Logging instead:\n${body}`,
      );
    }

    // Acknowledgement — best-effort, and only to the signed-in account's
    // own address: never to an address taken from the request body.
    if (input.accountEmail) {
      try {
        const ack = await this.email.sendBugReportAck({
          to: input.accountEmail,
          reportId: id,
          subject: input.subject,
        });
        if (ack.skipped) {
          this.logger.log(`Bug report ack skipped for report ${id} (address bounced)`);
        } else if (ack.success === false) {
          this.logger.warn(`Bug report ack not sent for report ${id}: ${ack.error ?? "unknown error"}`);
        }
      } catch (err) {
        this.logger.warn(`Bug report ack failed for report ${id}: ${(err as Error).message}`);
      }
    }

    return id;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
