import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req, Optional } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse } from "@nestjs/swagger";
import { BugReportService } from "./bug-report.service";
import { SignedIn } from "../auth/decorators/signed-in.decorator";
import { BugReportDto, MAX_BUG_CONTEXT_BYTES } from "./bug-report.dto";

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
      "Submit a bug report. Anonymous-friendly. The report is emailed to the founder and persisted for the SaaS admin dashboard." })
  @ApiResponse({ status: 202, description: "Bug report accepted" })
  @SignedIn()
  async submit(
    @Body() dto: BugReportDto,
    @Req() req?: any,
  ): Promise<{ ok: true; id: string }> {
    const user = req?.user;
    if (dto.context && JSON.stringify(dto.context).length > MAX_BUG_CONTEXT_BYTES) {
      throw new BadRequestException("context too large");
    }
    const id = await this.service.submit({
      subject: dto.subject,
      description: dto.description,
      currentUrl: dto.currentUrl,
      appVersion: dto.appVersion,
      email: dto.email,
      context: dto.context,
      tenantId: user?.tenantId ?? null,
      authorId: user?.id ?? null });
    return { ok: true, id };
  }
}
