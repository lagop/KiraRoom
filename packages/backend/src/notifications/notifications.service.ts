import {
  Injectable,
  Logger,
  NotFoundException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma/prisma.service";
import { NotificationsGateway } from "./notifications.gateway";
import { TranslationsService } from "../translations/translations.service";
import {
  CreateNotificationDto,
  UpdateNotificationDto,
  NotificationFilterDto,
  NotificationPreferenceDto,
  BulkNotificationDto,
  MarkAllReadDto,
  NotificationType,
} from "./dto";

// Default notification preferences
const DEFAULT_PREFERENCES: Record<
  string,
  { inApp: boolean; email: boolean; sms: boolean; whatsapp: boolean }
> = {
  appointment_created: {
    inApp: true,
    email: true,
    sms: false,
    whatsapp: false,
  },
  appointment_confirmed: {
    inApp: true,
    email: true,
    sms: true,
    whatsapp: false,
  },
  appointment_cancelled: {
    inApp: true,
    email: true,
    sms: true,
    whatsapp: false,
  },
  appointment_reminder_24h: {
    inApp: true,
    email: true,
    sms: true,
    whatsapp: false,
  },
  appointment_reminder_1h: {
    inApp: true,
    email: false,
    sms: true,
    whatsapp: false,
  },
  appointment_completed: {
    inApp: true,
    email: true,
    sms: false,
    whatsapp: false,
  },
  review_request: { inApp: true, email: true, sms: false, whatsapp: false },
  payment_received: { inApp: true, email: true, sms: false, whatsapp: false },
  payment_failed: { inApp: true, email: true, sms: true, whatsapp: false },
  promotion: { inApp: true, email: true, sms: false, whatsapp: false },
  news: { inApp: true, email: true, sms: false, whatsapp: false },
  special_offer: { inApp: true, email: true, sms: false, whatsapp: false },
  system_alert: { inApp: true, email: true, sms: false, whatsapp: false },
  new_appointment_assigned: {
    inApp: true,
    email: true,
    sms: false,
    whatsapp: false,
  },
  schedule_change: { inApp: true, email: true, sms: false, whatsapp: false },
  new_message: { inApp: true, email: false, sms: false, whatsapp: false },
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => NotificationsGateway))
    private readonly gateway: NotificationsGateway,
    private readonly translationsService: TranslationsService,
  ) {}

  /**
   * Create a new notification
   * Persists to DB first, then can be queued for delivery
   */
  async create(dto: CreateNotificationDto) {
    this.logger.log(
      `Creating notification: type=${dto.type}, userId=${dto.userId || "none"}, clientId=${dto.clientId || "none"}, tenantId=${dto.tenantId}`,
    );

    const notification = await this.prisma.notification.create({
      data: {
        tenantId: dto.tenantId,
        userId: dto.userId,
        clientId: dto.clientId,
        type: dto.type as any, // Cast to Prisma enum
        title: dto.title,
        message: dto.message,
        data: dto.data || {},
      },
    });

    this.logger.log(
      `Created notification ${notification.id} of type ${dto.type} for ${dto.clientId ? `client ${dto.clientId}` : `user ${dto.userId}`}`,
    );

    // Emit real-time notification via WebSocket
    if (this.gateway) {
      const notificationData = {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        data: notification.data,
        createdAt: notification.createdAt,
        isRead: notification.isRead,
      };

      if (dto.userId) {
        this.gateway.emitToUser(dto.userId, "notification", notificationData);
      } else if (dto.clientId) {
        this.gateway.emitToClient(
          dto.clientId,
          "notification",
          notificationData,
        );
      }
    }

    // TODO: Queue delivery job when queue is implemented
    // await this.enqueueDelivery(notification);

    return notification;
  }

  /**
   * Get notifications for a user with filtering and pagination
   */
  async findForUser(userId: string, filter: NotificationFilterDto) {
    const where: any = {
      userId,
      archivedAt: null,
    };

    if (filter.isRead !== undefined) {
      where.isRead = filter.isRead;
    }

    if (filter.type) {
      where.type = filter.type;
    }

    if (filter.search) {
      where.OR = [
        { title: { contains: filter.search, mode: "insensitive" } },
        { message: { contains: filter.search, mode: "insensitive" } },
      ];
    }

    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: filter.limit || 20,
        skip: filter.offset || 0,
        include: {
          deliveries: true,
        },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({
        where: {
          userId,
          isRead: false,
          archivedAt: null,
        },
      }),
    ]);

    return {
      data: notifications,
      total,
      unreadCount,
      limit: filter.limit || 20,
      offset: filter.offset || 0,
    };
  }

  /**
   * Get notifications for a client with filtering and pagination
   */
  async findForClient(clientId: string, filter: NotificationFilterDto) {
    this.logger.log(`Finding notifications for client ${clientId}`);

    const where: any = {
      clientId,
      archivedAt: null,
    };

    if (filter.isRead !== undefined) {
      where.isRead = filter.isRead;
    }

    if (filter.type) {
      where.type = filter.type;
    }

    if (filter.search) {
      where.OR = [
        { title: { contains: filter.search, mode: "insensitive" } },
        { message: { contains: filter.search, mode: "insensitive" } },
      ];
    }

    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: filter.limit || 20,
        skip: filter.offset || 0,
        include: {
          deliveries: true,
        },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({
        where: {
          clientId,
          isRead: false,
          archivedAt: null,
        },
      }),
    ]);

    return {
      data: notifications,
      total,
      unreadCount,
      limit: filter.limit || 20,
      offset: filter.offset || 0,
    };
  }

  /**
   * Get unread count for a user
   */
  async getUnreadCountForUser(userId: string) {
    return this.prisma.notification.count({
      where: {
        userId,
        isRead: false,
        archivedAt: null,
      },
    });
  }

  /**
   * Get unread count for a client
   */
  async getUnreadCountForClient(clientId: string) {
    return this.prisma.notification.count({
      where: {
        clientId,
        isRead: false,
        archivedAt: null,
      },
    });
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(notificationId: string, userId?: string, clientId?: string) {
    const where: any = { id: notificationId };
    if (userId) where.userId = userId;
    if (clientId) where.clientId = clientId;

    const notification = await this.prisma.notification.findFirst({ where });

    if (!notification) {
      throw new NotFoundException("Notification not found");
    }

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsReadForUser(userId: string, dto: MarkAllReadDto) {
    const where: any = {
      userId,
      isRead: false,
      archivedAt: null,
    };

    if (dto.type) {
      where.type = dto.type;
    }

    return this.prisma.notification.updateMany({
      where,
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
  }

  /**
   * Mark all notifications as read for a client
   */
  async markAllAsReadForClient(clientId: string, dto: MarkAllReadDto) {
    const where: any = {
      clientId,
      isRead: false,
      archivedAt: null,
    };

    if (dto.type) {
      where.type = dto.type;
    }

    return this.prisma.notification.updateMany({
      where,
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });
  }

  /**
   * Archive (soft delete) a notification
   */
  async archive(notificationId: string, userId?: string, clientId?: string) {
    const where: any = { id: notificationId };
    if (userId) where.userId = userId;
    if (clientId) where.clientId = clientId;

    const notification = await this.prisma.notification.findFirst({ where });

    if (!notification) {
      throw new NotFoundException("Notification not found");
    }

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        archivedAt: new Date(),
      },
    });
  }

  /**
   * Get notification preferences for a user
   */
  async getPreferencesForUser(userId: string) {
    const preference = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });

    if (!preference) {
      return { preferences: DEFAULT_PREFERENCES };
    }

    return preference;
  }

  /**
   * Get notification preferences for a client
   */
  async getPreferencesForClient(clientId: string) {
    const preference = await this.prisma.notificationPreference.findUnique({
      where: { clientId },
    });

    if (!preference) {
      return { preferences: DEFAULT_PREFERENCES };
    }

    return preference;
  }

  /**
   * Update notification preferences for a user
   */
  async updatePreferencesForUser(
    userId: string,
    tenantId: string,
    dto: NotificationPreferenceDto,
  ) {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: {
        userId,
        tenantId,
        preferences: dto.preferences as any,
      },
      update: {
        preferences: dto.preferences as any,
      },
    });
  }

  /**
   * Update notification preferences for a client
   */
  async updatePreferencesForClient(
    clientId: string,
    tenantId: string,
    dto: NotificationPreferenceDto,
  ) {
    return this.prisma.notificationPreference.upsert({
      where: { clientId },
      create: {
        clientId,
        tenantId,
        preferences: dto.preferences as any,
      },
      update: {
        preferences: dto.preferences as any,
      },
    });
  }

  /**
   * Send bulk notifications to clients
   */
  async sendBulkToClients(dto: BulkNotificationDto) {
    let clientIds = dto.clientIds;

    // If sendToAllClients is true, get all client IDs for the tenant
    if (dto.sendToAllClients) {
      const clients = await this.prisma.client.findMany({
        where: { tenantId: dto.tenantId },
        select: { id: true },
      });
      clientIds = clients.map((c) => c.id);
    }

    if (!clientIds || clientIds.length === 0) {
      return { created: 0 };
    }

    // Create notifications in batches
    const batchSize = 100;
    let created = 0;

    for (let i = 0; i < clientIds.length; i += batchSize) {
      const batch = clientIds.slice(i, i + batchSize);

      const notifications = await this.prisma.notification.createMany({
        data: batch.map((clientId) => ({
          tenantId: dto.tenantId,
          clientId,
          type: dto.type as any,
          title: dto.title,
          message: dto.message,
          data: dto.data || {},
        })),
      });

      created += notifications.count;
    }

    this.logger.log(
      `Created ${created} bulk notifications of type ${dto.type}`,
    );

    // TODO: Queue delivery jobs when queue is implemented

    return { created };
  }

  /**
   * Get default preferences
   */
  getDefaultPreferences() {
    return DEFAULT_PREFERENCES;
  }

  /**
   * Check if a notification should be sent via a specific channel
   * @param clientId The client ID to check preferences for
   * @param notificationType The type of notification (e.g., 'appointment_confirmed')
   * @param channel The channel to check (email, sms, whatsapp, inApp)
   * @returns boolean indicating if the notification should be sent
   */
  async shouldSendNotification(
    clientId: string,
    notificationType: string,
    channel: "email" | "sms" | "whatsapp" | "inApp",
  ): Promise<boolean> {
    const preference = await this.prisma.notificationPreference.findUnique({
      where: { clientId },
    });

    this.logger.debug(
      `Checking notification preferences for client ${clientId}, type ${notificationType}, channel ${channel}. Found: ${JSON.stringify(preference)}`,
    );

    if (!preference) {
      // Use defaults if no preferences set
      const result = DEFAULT_PREFERENCES[notificationType]?.[channel] ?? true;
      this.logger.debug(`No preferences found, using default: ${result}`);
      return result;
    }

    const prefs = preference.preferences as Record<
      string,
      Record<string, boolean>
    >;
    const clientPref = prefs[notificationType]?.[channel];
    const defaultPref = DEFAULT_PREFERENCES[notificationType]?.[channel];
    const result = clientPref ?? defaultPref ?? true;
    this.logger.debug(
      `Client pref: ${clientPref}, Default: ${defaultPref}, Result: ${result}`,
    );
    return result;
  }

  /**
   * Check if a notification should be sent via a specific channel for a user (staff/admin)
   * @param userId The user ID to check preferences for
   * @param notificationType The type of notification (e.g., 'new_appointment_assigned')
   * @param channel The channel to check (email, sms, whatsapp, inApp)
   * @returns boolean indicating if the notification should be sent
   */
  async shouldSendNotificationForUser(
    userId: string,
    notificationType: string,
    channel: "email" | "sms" | "whatsapp" | "inApp",
  ): Promise<boolean> {
    const preference = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });

    if (!preference) {
      // Use defaults if no preferences set
      return DEFAULT_PREFERENCES[notificationType]?.[channel] ?? true;
    }

    const prefs = preference.preferences as Record<
      string,
      Record<string, boolean>
    >;
    return (
      prefs[notificationType]?.[channel] ??
      DEFAULT_PREFERENCES[notificationType]?.[channel] ??
      true
    );
  }

  /**
   * Cron job to clean up old archived notifications (90 days)
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanupOldNotifications() {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const result = await this.prisma.notification.deleteMany({
      where: {
        archivedAt: {
          lt: ninetyDaysAgo,
        },
      },
    });

    if (result.count > 0) {
      this.logger.log(`Cleaned up ${result.count} old archived notifications`);
    }
  }
}
