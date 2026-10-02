import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles, SALON_MANAGERS, SALON_TEAM } from '../auth/decorators/roles.decorator';
import { WaitListService } from './wait-list.service';
import {
  NotifyWaitListDto,
  WAIT_LIST_STATUSES,
  WaitListCreateDto,
  WaitListSettingsDto,
  WaitListStatus,
  WaitListUpdateDto,
} from './wait-list.dto';

/**
 * The tenant comes from the session. It used to come from the query string
 * and the body, and update/delete took any id.
 */
@Controller('wait-list')
@UseGuards(JwtAuthGuard)
export class WaitListController {
  constructor(private readonly svc: WaitListService) {}

  @Get()
  @Roles(...SALON_TEAM)
  list(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('serviceId') serviceId?: string,
  ) {
    const valid = (WAIT_LIST_STATUSES as readonly string[]).includes(status ?? '');
    return this.svc.list(req.user.tenantId, {
      status: valid ? (status as WaitListStatus) : undefined,
      serviceId,
    });
  }

  @Get('settings')
  @Roles(...SALON_TEAM)
  settings(@Req() req: any) {
    return this.svc.getSettings(req.user.tenantId);
  }

  @Put('settings')
  @Roles(...SALON_MANAGERS)
  saveSettings(@Req() req: any, @Body() dto: WaitListSettingsDto) {
    return this.svc.updateSettings(req.user.tenantId, dto.autoNotify);
  }

  /** Which channels can deliver a notice right now. */
  @Get('channels')
  @Roles(...SALON_TEAM)
  channels(@Req() req: any) {
    return this.svc.channels(req.user.tenantId);
  }

  @Post()
  @Roles(...SALON_TEAM)
  add(@Req() req: any, @Body() dto: WaitListCreateDto) {
    return this.svc.add(req.user.tenantId, dto);
  }

  /** "Avisar": tells the client a slot opened, by email, WhatsApp or SMS. */
  @Post(':id/notify')
  @Roles(...SALON_TEAM)
  notify(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NotifyWaitListDto,
  ) {
    return this.svc.notify(req.user.tenantId, id, dto, req.user.id);
  }

  @Patch(':id')
  @Roles(...SALON_TEAM)
  update(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: WaitListUpdateDto,
  ) {
    return this.svc.update(req.user.tenantId, id, dto);
  }

  @Delete(':id')
  @Roles(...SALON_TEAM)
  remove(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(req.user.tenantId, id);
  }
}
