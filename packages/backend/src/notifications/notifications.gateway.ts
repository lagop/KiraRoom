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
import { ConfigService } from '@nestjs/config';
import { verify } from 'jsonwebtoken';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../common/prisma/prisma.service';

/** Who a socket belongs to, taken from its access token. */
export interface SocketIdentity {
  userId?: string;
  clientId?: string;
  tenantId: string;
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
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Only a valid access token gets a socket, and the rooms it joins come
   * from that token.
   *
   * The handshake used to carry tenantId, userId and clientId as plain
   * fields and the gateway trusted them, so anyone who knew a salon's id
   * (it is public) or a user's id received their notifications, with no
   * token at all.
   */
  async handleConnection(client: SocketWithAuth) {
    const identity = await this.identify(client);
    if (!identity) {
      client.disconnect(true);
      return;
    }
    client.data = identity;
    if (identity.clientId) {
      client.join(`client:${identity.clientId}`);
    } else {
      client.join(`user:${identity.userId}`);
      client.join(`tenant:${identity.tenantId}`);
    }
  }

  /** The token's owner, if the token is valid and the account still active. */
  async identify(client: Pick<Socket, 'handshake' | 'id'>): Promise<SocketIdentity | null> {
    const fromAuth = (client.handshake.auth as { token?: unknown } | undefined)?.token;
    const header = client.handshake.headers?.authorization;
    const raw =
      typeof fromAuth === 'string'
        ? fromAuth
        : typeof header === 'string'
          ? header
          : '';
    const token = raw.replace(/^Bearer\s+/i, '');
    const secret = this.config.get<string>('JWT_SECRET');
    if (!token || !secret) {
      this.logger.warn(`Socket ${client.id} refused: no token`);
      return null;
    }

    let payload: { sub?: string; role?: string };
    try {
      payload = verify(token, secret) as { sub?: string; role?: string };
    } catch {
      this.logger.warn(`Socket ${client.id} refused: invalid token`);
      return null;
    }
    if (!payload.sub) return null;

    if (payload.role === 'client') {
      const found = await this.prisma.client.findUnique({
        where: { id: payload.sub },
        select: { id: true, tenantId: true, status: true },
      });
      if (!found || found.status === 'blocked') return null;
      return { clientId: found.id, tenantId: found.tenantId };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, tenantId: true, isActive: true },
    });
    if (!user || !user.isActive || !user.tenantId) return null;
    return { userId: user.id, tenantId: user.tenantId };
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
