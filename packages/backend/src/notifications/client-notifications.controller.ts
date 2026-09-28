import { ParseUUIDPipe, Controller, Get, Put, Delete, Body, Param, Query, Logger, UseGuards } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { 
  NotificationFilterDto, 
  NotificationPreferenceDto,
  MarkAllReadDto,
} from './dto';

/**
 * A client's own notifications and preferences, for the salon site's account
 * area.
 *
 * Every route here used to be @Public() and took the client from a
 * `?clientId=` query parameter: whoever had a client's id could read their
 * notifications, archive them and rewrite their preferences, and nothing
 * checked it. The client now comes from their own token. The frontend still
 * sends `clientId`; it is ignored.
 */
@ApiTags('client-notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.client)
@Controller('client/notifications')
export class ClientNotificationsController {
  private readonly logger = new Logger(ClientNotificationsController.name);

  constructor(private readonly notificationsService: NotificationsService) {}

  // ==========================================
  // Client (Salon Site) Endpoints
  // ==========================================

  @Get()
  @ApiOperation({ summary: 'Get all notifications for the current client' })
  async findAllForClient(
    @CurrentUser() client: { id: string },
    @Query() filter: NotificationFilterDto,
  ) {
    this.logger.log(`GET /client/notifications - clientId: ${client.id}`);
    const result = await this.notificationsService.findForClient(client.id, filter);
    this.logger.log(`Returning ${result.data?.length || 0} notifications for client ${client.id}`);
    return result;
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notifications count for the current client' })
  async getUnreadCountForClient(@CurrentUser() client: { id: string }) {
    this.logger.log(`GET /client/notifications/unread-count - clientId: ${client.id}`);
    const count = await this.notificationsService.getUnreadCountForClient(client.id);
    this.logger.log(`Unread count for client ${client.id}: ${count}`);
    return { count };
  }

  @Put(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read for client' })
  async markAsReadForClient(
    @CurrentUser() client: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markAsRead(id, undefined, client.id);
  }

  @Put('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read for the current client' })
  async markAllAsReadForClient(
    @CurrentUser() client: { id: string },
    @Body() dto: MarkAllReadDto,
  ) {
    return this.notificationsService.markAllAsReadForClient(client.id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Archive a notification for client' })
  async archiveForClient(
    @CurrentUser() client: { id: string },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.archive(id, undefined, client.id);
  }

  // ==========================================
  // Client Preferences Endpoints
  // ==========================================

  @Get('preferences')
  @ApiOperation({ summary: 'Get notification preferences for the current client' })
  async getPreferencesForClient(@CurrentUser() client: { id: string }) {
    return this.notificationsService.getPreferencesForClient(client.id);
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Update notification preferences for the current client' })
  async updatePreferencesForClient(
    @CurrentUser() client: { id: string; tenantId: string },
    @Body() dto: NotificationPreferenceDto,
  ) {
    return this.notificationsService.updatePreferencesForClient(
      client.id,
      client.tenantId,
      dto,
    );
  }
}
