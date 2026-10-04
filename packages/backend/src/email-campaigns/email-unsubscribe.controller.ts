import { Controller, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/decorators/public.decorator";
import { EmailUnsubscribeService } from "./email-unsubscribe.service";

/**
 * The unsubscribe link of marketing emails.
 *
 * Public: whoever has the email has the link, and the link is signed
 * (EmailUnsubscribeService). GET only describes, so a mail scanner that
 * follows links cannot unsubscribe anyone; the POST does it, from the page's
 * button or from a mail client's one-click button (RFC 8058, which posts
 * "List-Unsubscribe=One-Click" to this same URL and ignores the answer).
 */
@ApiTags("Email unsubscribe")
@Public()
@Controller("public/email/unsubscribe")
export class EmailUnsubscribeController {
  constructor(private readonly unsubscribes: EmailUnsubscribeService) {}

  @Get(":token")
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "Which salon and address a link unsubscribes" })
  describe(@Param("token") token: string) {
    return this.unsubscribes.describe(token);
  }

  @Post(":token")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "Unsubscribe the address from the salon's marketing emails" })
  unsubscribe(@Param("token") token: string) {
    return this.unsubscribes.unsubscribe(token);
  }
}
