import { ParseUUIDPipe, Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, Request } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { NotificationQueue } from './queue/notification.queue';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { 
  NotificationFilterDto, 
  NotificationPreferenceDto,
  MarkAllReadDto,
  BulkNotificationDto,
} from './dto';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly notificationQueue: NotificationQueue,
  ) {}

  // ==========================================
  // User (Dashboard) Endpoints
  // ==========================================

  @Get()
  @ApiOperation({ summary: 'Get all notifications for the current user' })
  async findAllForUser(
    @CurrentUser() user: any,
    @Query() filter: NotificationFilterDto,
  ) {
    return this.notificationsService.findForUser(user.id, filter);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notifications count for the current user' })
  async getUnreadCountForUser(@CurrentUser() user: any) {
    const count = await this.notificationsService.getUnreadCountForUser(user.id);
    return { count };
  }

  @Put(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  async markAsReadForUser(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markAsRead(id, user.id);
  }

  @Put('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read for the current user' })
  async markAllAsReadForUser(
    @CurrentUser() user: any,
    @Body() dto: MarkAllReadDto,
  ) {
    return this.notificationsService.markAllAsReadForUser(user.id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Archive a notification' })
  async archiveForUser(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.archive(id, user.id);
  }

  // ==========================================
  // Preferences Endpoints
  // ==========================================

  @Get('preferences')
  @ApiOperation({ summary: 'Get notification preferences for the current user' })
  async getPreferencesForUser(@CurrentUser() user: any) {
    return this.notificationsService.getPreferencesForUser(user.id);
  }

  @Put('preferences')
  @ApiOperation({ summary: 'Update notification preferences for the current user' })
  async updatePreferencesForUser(
    @CurrentUser() user: any,
    @Body() dto: NotificationPreferenceDto,
  ) {
    return this.notificationsService.updatePreferencesForUser(
      user.id,
      user.tenantId,
      dto,
    );
  }

  // ==========================================
  // Admin Endpoints
  // ==========================================

  @Post('bulk')
  @ApiOperation({ summary: 'Send bulk notifications to clients' })
  async sendBulkToClients(@Body() dto: BulkNotificationDto) {
    return this.notificationsService.sendBulkToClients(dto);
  }

  // ==========================================
  // Queue Stats Endpoint
  // ==========================================

  @Get('queue/stats')
  @ApiOperation({ summary: 'Get notification queue statistics' })
  async getQueueStats() {
    return this.notificationQueue.getQueueStats();
  }
}
