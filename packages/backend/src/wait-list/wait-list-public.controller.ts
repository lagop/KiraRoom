import { Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { WaitListService } from './wait-list.service';

/**
 * "Ya no me interesa": the link in wait-list notices (email and SMS) that
 * takes a client off the list without an account.
 *
 * Public: whoever has the notice has the link, and the link is signed
 * (waitListLeaveToken). GET only describes, so a mail scanner that follows
 * links removes nobody; the page's button sends the POST. Rate-limited like
 * the unsubscribe link.
 */
@ApiTags('Wait list (public)')
@Public()
@Controller('public/wait-list')
export class WaitListPublicController {
  constructor(private readonly svc: WaitListService) {}

  @Get(':token')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: 'Which salon and service a wait-list link is for, and whether still waiting' })
  describe(@Param('token') token: string) {
    return this.svc.describeLeaveLink(token);
  }

  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({ summary: 'Take the client off the wait list' })
  leave(@Param('token') token: string) {
    return this.svc.leaveByToken(token);
  }
}
