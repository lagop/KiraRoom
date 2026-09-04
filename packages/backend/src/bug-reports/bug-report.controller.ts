import { ParseUUIDPipe, Body, Controller, HttpCode, HttpStatus, Post, Req, Optional } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
} from "@nestjs/swagger";
import { BugReportService } from "./bug-report.service";

interface BugReportDto {
  subject: string;
  description: string;
  /** Optional context — filled by the frontend automatically. */
  currentUrl?: string;
  appVersion?: string;
  /**
   * Optional email of the reporter. When provided, an automated
   * acknowledgement is sent back so the reporter has a tracking id
   * they can reference. Anonymous reports (no email) skip the ack.
   */
  email?: string;
  /** Free-form JSON for additional context (last 10 log lines, viewport size, etc.). */
  context?: Record<string, unknown>;
}

/**
 * One-click bug-report endpoint.
 *
 * The frontend sidebar has a "🐞 Report a bug" button that opens a
 * small modal pre-filled with the current URL and app version. This
 * endpoint receives the report and emails the founder with full context.
 *
 * **Important:** Do NOT gate this behind auth. Bug reports from
 * logged-out users (e.g. on the marketing site or the login screen)
 * are still useful.
 *
 * This is part of Workstream 1.5 of the zero-budget launch roadmap
 * (`plans/1784285888087-zero-budget-launch-roadmap.md`). Goal: cut the
 * round-trip time of "what version are you on?" from hours to minutes.
 */
@ApiTags("Bug reports")
@Controller("bug-reports")
export class BugReportController {
  constructor(
    private readonly service: BugReportService,
    // Optional so anonymous callers (no JWT) don't fail. The
    // JwtAuthGuard is registered globally with `optional: true` for
    // this route via APP_GUARD wiring in AppModule — see below.
    @Optional() private readonly reqHolder?: { req: any },
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      "Submit a bug report. Anonymous-friendly. The report is emailed to the founder and persisted for the SaaS admin dashboard.",
  })
  @ApiResponse({ status: 202, description: "Bug report accepted" })
  async submit(
    @Body() dto: BugReportDto,
    @Req() req?: any,
  ): Promise<{ ok: true; id: string }> {
    const user = req?.user;
    const id = await this.service.submit({
      ...dto,
      tenantId: user?.tenantId ?? null,
      authorId: user?.id ?? null,
    });
    return { ok: true, id };
  }
}
