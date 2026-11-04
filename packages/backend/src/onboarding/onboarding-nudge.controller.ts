import { Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/decorators/public.decorator";
import { OnboardingNudgeService } from "./onboarding-nudge.service";

/**
 * The unsubscribe link of KiraRoom's tips to salon owners (the day-2
 * onboarding reminder, audit 7 D17). Public and signed, like the salons'
 * marketing unsubscribe: GET only describes, so a mail scanner that follows
 * links unsubscribes nobody; the POST does it, from the page's button or a
 * mail client's one-click button (RFC 8058).
 */
@ApiTags("Email unsubscribe")
@Public()
@Controller("public/email/tips-unsubscribe")
export class OnboardingNudgeController {
  constructor(private readonly nudges: OnboardingNudgeService) {}

  @Get(":token")
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "Whether a tips unsubscribe link is valid, and already used" })
  async describe(@Param("token") token: string) {
    const found = await this.nudges.describe(token);
    if (!found) throw new NotFoundException("Enlace no válido");
    return found;
  }

  @Post(":token")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: "No more KiraRoom tips to this user" })
  async unsubscribe(@Param("token") token: string) {
    const done = await this.nudges.unsubscribe(token);
    if (!done) throw new NotFoundException("Enlace no válido");
    return done;
  }
}
