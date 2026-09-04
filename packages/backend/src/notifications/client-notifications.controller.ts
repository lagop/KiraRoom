import { ParseUUIDPipe, Controller, Get, Put, Delete, Body, Param, Query, Logger } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { Public } from '../auth/decorators/public.decorator';
import { 
  NotificationFilterDto, 
  NotificationPreferenceDto,
  MarkAllReadDto,
} from './dto';

@ApiTags('client-notifications')
@ApiBearerAuth()
@Controller('client/notifications')
export class ClientNotificationsController {
  private readonly logger = new Logger(ClientNotificationsController.name);

  constructor(private readonly notificationsService: NotificationsService) {}

  // ==========================================
  // Client (Salon Site) Endpoints
  // All endpoints are public but require clientId for authorization
  // ==========================================

  @Public()
  @Get()
  @ApiOperation({ summary: 'Get all notifications for the current client' })
  async findAllForClient(
    @Query('clientId') clientId: string,
    @Query() filter: NotificationFilterDto,
  ) {
    this.logger.log(`GET /client/notifications - clientId: ${clientId}`);
    const result = await this.notificationsService.findForClient(clientId, filter);
    this.logger.log(`Returning ${result.data?.length || 0} notifications for client ${clientId}`);
    return result;
  }

  @Public()
  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notifications count for the current client' })
  async getUnreadCountForClient(@Query('clientId') clientId: string) {
    this.logger.log(`GET /client/notifications/unread-count - clientId: ${clientId}`);
    const count = await this.notificationsService.getUnreadCountForClient(clientId);
    this.logger.log(`Unread count for client ${clientId}: ${count}`);
    return { count };
  }

  @Public()
  @Put(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read for client' })
  async markAsReadForClient(
    @Query('clientId') clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markAsRead(id, undefined, clientId);
  }

  @Public()
  @Put('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read for the current client' })
  async markAllAsReadForClient(
    @Query('clientId') clientId: string,
    @Body() dto: MarkAllReadDto,
  ) {
    return this.notificationsService.markAllAsReadForClient(clientId, dto);
  }

  @Public()
  @Delete(':id')
  @ApiOperation({ summary: 'Archive a notification for client' })
  async archiveForClient(
    @Query('clientId') clientId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.archive(id, undefined, clientId);
  }

  // ==========================================
  // Client Preferences Endpoints
  // ==========================================

  @Public()
  @Get('preferences')
  @ApiOperation({ summary: 'Get notification preferences for the current client' })
  async getPreferencesForClient(@Query('clientId') clientId: string) {
    return this.notificationsService.getPreferencesForClient(clientId);
  }

  @Public()
  @Put('preferences')
  @ApiOperation({ summary: 'Update notification preferences for the current client' })
  async updatePreferencesForClient(
    @Query('clientId') clientId: string,
    @Query('tenantId') tenantId: string,
    @Body() dto: NotificationPreferenceDto,
  ) {
    return this.notificationsService.updatePreferencesForClient(
      clientId,
      tenantId,
      dto,
    );
  }
}
