import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, SALON_MANAGERS, SALON_TEAM } from '../auth/decorators/roles.decorator';
import { CashSessionsService } from './cash-sessions.service';
import {
  CashMovementDto,
  CashSessionListQueryDto,
  CloseCashSessionDto,
  OpenCashSessionDto,
} from './dto/cash-session.dto';

/**
 * The cash drawer at the till (apertura y cierre de caja, arqueo):
 * CashSessionsService. Anyone on the team runs the till: opens it, puts
 * money in or takes it out, counts and closes it. The history of past
 * sessions is the owner's and managers'.
 *
 * Staff count blind: every session they get back is the blind view (no
 * expected cash, no totals, no difference), shaped by the service from the
 * caller's role, so the panel cannot show what the server never sent.
 */
@ApiTags('POS')
@ApiBearerAuth()
@Controller('pos/cash-sessions')
export class CashSessionsController {
  constructor(private readonly cashSessions: CashSessionsService) {}

  private actor(req: any) {
    return { id: req.user.id as string, role: req.user.role as string };
  }

  @Get('current')
  @ApiOperation({ summary: 'The open cash-drawer session (what it should hold: owner and managers only)' })
  @Roles(...SALON_TEAM)
  async current(@Req() req: any) {
    return this.cashSessions.current(req.user.tenantId, this.actor(req));
  }

  @Post('open')
  @ApiOperation({ summary: 'Open the cash drawer with a float' })
  @Roles(...SALON_TEAM)
  async open(@Req() req: any, @Body() body: OpenCashSessionDto) {
    return this.cashSessions.open(req.user.tenantId, this.actor(req), body);
  }

  @Post(':id/movements')
  @ApiOperation({ summary: 'Put money into or take it out of the open drawer' })
  @Roles(...SALON_TEAM)
  async addMovement(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() body: CashMovementDto) {
    return this.cashSessions.addMovement(req.user.tenantId, id, this.actor(req), body);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Close the drawer with the cash counted (arqueo)' })
  @Roles(...SALON_TEAM)
  async close(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() body: CloseCashSessionDto) {
    return this.cashSessions.close(req.user.tenantId, id, this.actor(req), body);
  }

  @Get()
  @ApiOperation({ summary: 'Past cash-drawer sessions (owner and managers)' })
  @Roles(...SALON_MANAGERS)
  async list(@Req() req: any, @Query() query: CashSessionListQueryDto) {
    return this.cashSessions.list(req.user.tenantId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A cash-drawer session report' })
  @Roles(...SALON_TEAM)
  async report(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.cashSessions.report(req.user.tenantId, id, this.actor(req));
  }
}
