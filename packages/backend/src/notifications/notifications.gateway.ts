import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

interface AuthPayload {
  userId?: string;
  clientId?: string;
  tenantId: string;
  token?: string;
}

interface SocketWithAuth extends Socket {
  data: {
    userId?: string;
    clientId?: string;
    tenantId: string;
  };
}

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/notifications',
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);

  constructor(
    @Inject(forwardRef(() => NotificationsService))
    private readonly notificationsService: NotificationsService,
  ) {}

  async handleConnection(client: SocketWithAuth) {
    try {
      // Extract auth data from handshake
      const { userId, clientId, tenantId, token } =
        client.handshake.auth as AuthPayload;

      if (!tenantId) {
        this.logger.warn(
          `Client ${client.id} disconnected: missing tenantId`,
        );
        client.disconnect();
        return;
      }

      // Store user/client info in socket data
      client.data = {
        userId,
        clientId,
        tenantId,
      };

      // Join tenant-specific room
      client.join(`tenant:${tenantId}`);

      // Join user-specific or client-specific room
      if (userId) {
        client.join(`user:${userId}`);
        this.logger.log(
          `User ${userId} connected to tenant ${tenantId} (socket: ${client.id})`,
        );
      } else if (clientId) {
        client.join(`client:${clientId}`);
        this.logger.log(
          `Client ${clientId} connected to tenant ${tenantId} (socket: ${client.id})`,
        );
      } else {
        this.logger.log(
          `Anonymous connection to tenant ${tenantId} (socket: ${client.id})`,
        );
      }
    } catch (error) {
      this.logger.error(`Connection error: ${error.message}`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: SocketWithAuth) {
    const { userId, clientId, tenantId } = client.data || {};
    
    if (userId) {
      this.logger.log(`User ${userId} disconnected (socket: ${client.id})`);
    } else if (clientId) {
      this.logger.log(`Client ${clientId} disconnected (socket: ${client.id})`);
    } else {
      this.logger.log(`Socket ${client.id} disconnected`);
    }
  }

  /**
   * Emit a notification to a specific user
   */
  emitToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
    this.logger.debug(`Emitted ${event} to user:${userId}`);
  }

  /**
   * Emit a notification to a specific client
   */
  emitToClient(clientId: string, event: string, data: any) {
    this.server.to(`client:${clientId}`).emit(event, data);
    this.logger.debug(`Emitted ${event} to client:${clientId}`);
  }

  /**
   * Emit a notification to all users in a tenant (admins/professionals)
   */
  emitToTenant(tenantId: string, event: string, data: any) {
    this.server.to(`tenant:${tenantId}`).emit(event, data);
    this.logger.debug(`Emitted ${event} to tenant:${tenantId}`);
  }

  /**
   * Handle subscription to specific notification types
   */
  @SubscribeMessage('subscribe')
  async handleSubscribe(
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: { types?: string[] },
  ) {
    const { types } = data;
    
    if (types && Array.isArray(types)) {
      // Join rooms for specific notification types
      types.forEach((type) => {
        client.join(`type:${type}`);
      });
      this.logger.log(
        `Client ${client.id} subscribed to notification types: ${types.join(', ')}`,
      );
    }

    return { success: true, subscribed: types };
  }

  /**
   * Handle unsubscription from notification types
   */
  @SubscribeMessage('unsubscribe')
  async handleUnsubscribe(
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: { types?: string[] },
  ) {
    const { types } = data;
    
    if (types && Array.isArray(types)) {
      types.forEach((type) => {
        client.leave(`type:${type}`);
      });
      this.logger.log(
        `Client ${client.id} unsubscribed from notification types: ${types.join(', ')}`,
      );
    }

    return { success: true, unsubscribed: types };
  }

  /**
   * Handle mark as read event
   */
  @SubscribeMessage('markAsRead')
  async handleMarkAsRead(
    @ConnectedSocket() client: SocketWithAuth,
    @MessageBody() data: { notificationId: string },
  ) {
    const { userId, clientId } = client.data;

    if (userId) {
      await this.notificationsService.markAsRead(data.notificationId, userId);
    } else if (clientId) {
      await this.notificationsService.markAsRead(data.notificationId, undefined, clientId);
    }

    return { success: true };
  }

  /**
   * Handle mark all as read event
   */
  @SubscribeMessage('markAllAsRead')
  async handleMarkAllAsRead(@ConnectedSocket() client: SocketWithAuth) {
    const { userId, clientId } = client.data;

    if (userId) {
      await this.notificationsService.markAllAsReadForUser(userId, {});
    } else if (clientId) {
      await this.notificationsService.markAllAsReadForClient(clientId, {});
    }

    return { success: true };
  }
}
