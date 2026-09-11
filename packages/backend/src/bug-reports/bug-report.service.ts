import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { EmailService } from "../notifications/services/email.service";
import { PrismaService } from "../common/prisma/prisma.service";

interface BugReportInput {
  subject: string;
  description: string;
  currentUrl?: string;
  appVersion?: string;
  email?: string;
  context?: Record<string, unknown>;
  /** Auto-attached by the global JWT guard when the user is logged in. */
  tenantId?: string | null;
  authorId?: string | null;
}

/**
 * Bug-report ingest service. Accepts an unconstrained description,
 * stamps it with a UUID + timestamp, persists it as a `BugReport` row
 * (visible in the SaaS admin dashboard) and forwards a copy via the
 * existing `EmailService` to the founder.
 *
 * The "founder email" is read from `FOUNDER_EMAIL` env var (default:
 * `founder@kiraroom.com`). When unset (early dev), the report is
 * logged to stdout instead.
 *
 * Sprint 2 / 2.3: if the reporter supplied an email, an automated
 * acknowledgement is sent back so they have a tracking id. Anonymous
 * reports (no email) skip the ack — the founder still receives the
 * full report.
 */
@Injectable()
export class BugReportService {
  private readonly logger = new Logger(BugReportService.name);

  constructor(
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
  ) {}

  async submit(input: BugReportInput): Promise<string> {
    const id = randomUUID();
    const recipient = process.env.FOUNDER_EMAIL ?? "founder@kiraroom.com";

    const body = [
      `Subject: ${input.subject}`,
      "",
      input.description,
      "",
      "--- Context ---",
      `URL:        ${input.currentUrl ?? "(not provided)"}`,
      `App:        ${input.appVersion ?? "(not provided)"}`,
      `Reporter:   ${input.email ?? "(anonymous)"}`,
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
          tenantId: input.tenantId ?? null,
          authorId: input.authorId ?? null,
          subject: input.subject,
          description: input.description,
          currentUrl: input.currentUrl ?? null,
          appVersion: input.appVersion ?? null,
          email: input.email ?? null,
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
      await this.email.sendEmail({
        to: recipient,
        subject: `[KiraRoom bug] ${input.subject} (${id.slice(0, 8)})`,
        html: `<pre style="font-family: ui-monospace, monospace; white-space: pre-wrap;">${escapeHtml(body)}</pre>`,
      });
      this.logger.log(`Bug report accepted: id=${id} subject="${input.subject}"`);
    } catch (err) {
      // The transport may not be wired in dev. Fall back to stdout
      // so the report isn't lost — the founder can grep logs.
      this.logger.warn(
        `Bug report (id=${id}, recipient=${recipient} failed to email: ${(err as Error).message}). Logging instead:\n${body}`,
      );
    }

    // Acknowledgement to the reporter — best-effort. Skipped for
    // anonymous reports (no email) and for bounced addresses.
    if (input.email) {
      try {
        const ack = await this.email.sendBugReportAck({
          to: input.email,
          reportId: id,
          subject: input.subject,
        });
        if (ack.skipped) {
          this.logger.log(
            `Bug report ack skipped for ${input.email} (address bounced)`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Bug report ack failed for ${input.email}: ${(err as Error).message}`,
        );
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
