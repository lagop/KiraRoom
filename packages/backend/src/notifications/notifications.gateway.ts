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
import { Logger, Inject, forwardRef, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { sessionRevocations, SessionRevocation } from '../auth/sessions/session-revocations';
import { ConfigService } from '@nestjs/config';
import { verify } from 'jsonwebtoken';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * Who a socket belongs to, taken from its access token: a member of a
 * salon's team. (Salon clients have no accounts, so no client socket.)
 */
export interface SocketIdentity {
  userId?: string;
  tenantId: string;
  /** The token's session version (tv) and expiry (exp, seconds): see recheckSockets. */
  tokenVersion?: number;
  expiresAt?: number;
}

interface SocketWithAuth extends Socket {
  data: SocketIdentity;
}

/** How often open sockets are checked against their accounts again. */
export const SOCKET_RECHECK_MS = 60_000;

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/notifications',
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);
  private stopListening?: () => void;

  constructor(
    @Inject(forwardRef(() => NotificationsService))
    private readonly notificationsService: NotificationsService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Ended sessions close their sockets at once (session-revocations.ts). */
  onModuleInit() {
    this.stopListening = sessionRevocations.on((r) => this.endSessions(r));
  }

  onModuleDestroy() {
    this.stopListening?.();
  }

  /**
   * Disconnects every socket of an account whose sessions just ended (a
   * team member deactivated or their access removed, a password changed, a
   * logout everywhere). Its token stopped working for HTTP at the same
   * moment (JwtStrategy reads tokenVersion on every request); the socket was
   * only checked when it connected, so it kept receiving the salon's live
   * notifications. The browser that changed its own password has a new
   * token and reconnects with it.
   */
  async endSessions(revocation: SessionRevocation): Promise<void> {
    if (!this.server) return;
    if (revocation.userId) this.server.in(`user:${revocation.userId}`).disconnectSockets(true);
  }

  /**
   * The safety net for anything that ends sessions without telling
   * session-revocations.ts: every open socket is checked again against its
   * account -- still active, same session version -- and against its token's
   * expiry, and closed when it no longer passes. One query, whatever the
   * number of sockets.
   */
  @Interval(SOCKET_RECHECK_MS)
  async recheckSockets(now: number = Date.now()): Promise<number> {
    if (!this.server) return 0;
    let sockets: Array<{ data: Partial<SocketIdentity>; disconnect: (close?: boolean) => unknown }>;
    try {
      sockets = (await this.server.fetchSockets()) as any;
    } catch (err) {
      this.logger.warn(`Socket re-check skipped: ${(err as Error).message}`);
      return 0;
    }
    if (sockets.length === 0) return 0;
    const userIds = [...new Set(sockets.map((s) => s.data?.userId).filter((id): id is string => !!id))];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, isActive: true, tokenVersion: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));
    let closed = 0;
    for (const socket of sockets) {
      const data = socket.data ?? {};
      const version = data.tokenVersion ?? 0;
      let valid = false;
      if (data.userId) {
        const u = userById.get(data.userId);
        valid = !!u && u.isActive && u.tokenVersion === version;
      }
      if (valid && data.expiresAt && now >= data.expiresAt * 1000) valid = false;
      if (!valid) {
        socket.disconnect(true);
        closed++;
      }
    }
    if (closed > 0) this.logger.log(`Closed ${closed} socket(s) whose session had ended`);
    return closed;
  }

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
    client.join(`user:${identity.userId}`);
    client.join(`tenant:${identity.tenantId}`);
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

    let payload: { sub?: string; role?: string; tv?: number; exp?: number };
    try {
      payload = verify(token, secret) as { sub?: string; role?: string; tv?: number; exp?: number };
    } catch {
      this.logger.warn(`Socket ${client.id} refused: invalid token`);
      return null;
    }
    if (!payload.sub) return null;

    // Clients have no accounts any more; a client token minted before that
    // gets no socket (as in JwtStrategy).
    if (payload.role === 'client') return null;
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, tenantId: true, isActive: true, tokenVersion: true },
    });
    if (!user || !user.isActive || !user.tenantId) return null;
    // Same rule as JwtStrategy: a logged-out session gets no socket.
    if ((payload.tv ?? 0) !== user.tokenVersion) return null;
    return { userId: user.id, tenantId: user.tenantId, tokenVersion: user.tokenVersion, expiresAt: payload.exp };
  }

  async handleDisconnect(client: SocketWithAuth) {
    const { userId } = client.data || {};

    if (userId) {
      this.logger.log(`User ${userId} disconnected (socket: ${client.id})`);
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
    const { userId } = client.data;

    if (userId) {
      await this.notificationsService.markAsRead(data.notificationId, userId);
    }

    return { success: true };
  }

  /**
   * Handle mark all as read event
   */
  @SubscribeMessage('markAllAsRead')
  async handleMarkAllAsRead(@ConnectedSocket() client: SocketWithAuth) {
    const { userId } = client.data;

    if (userId) {
      await this.notificationsService.markAllAsReadForUser(userId, {});
    }

    return { success: true };
  }
}
