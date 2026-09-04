'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface SocketAuth {
  userId?: string;
  clientId?: string;
  tenantId: string;
  token?: string;
}

interface NotificationData {
  id: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, any>;
  createdAt: string;
  isRead: boolean;
}

interface UseSocketOptions {
  userId?: string;
  clientId?: string;
  tenantId: string;
  token?: string;
  onNotification?: (notification: NotificationData) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  enabled?: boolean;
}

interface UseSocketReturn {
  socket: Socket | null;
  isConnected: boolean;
  subscribe: (types: string[]) => void;
  unsubscribe: (types: string[]) => void;
  markAsRead: (notificationId: string) => void;
  markAllAsRead: () => void;
}

// For Socket.io, we need the base URL without /api/v1 path
// If NEXT_PUBLIC_API_URL is http://localhost:3001/api/v1, we extract just http://localhost:3001
const getSocketUrl = () => {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
  // Remove /api/v1 or similar paths to get the base URL
  return apiUrl.replace(/\/api\/v\d+$/, '');
};
const SOCKET_URL = getSocketUrl();
const NOTIFICATION_NAMESPACE = '/notifications';

export function useSocket(options: UseSocketOptions): UseSocketReturn {
  const {
    userId,
    clientId,
    tenantId,
    token,
    onNotification,
    onConnect,
    onDisconnect,
    enabled = true,
  } = options;

  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!enabled || !tenantId) {
      return;
    }

    // Initialize socket connection
    const auth: SocketAuth = {
      tenantId,
      ...(userId && { userId }),
      ...(clientId && { clientId }),
      ...(token && { token }),
    };

    socketRef.current = io(`${SOCKET_URL}${NOTIFICATION_NAMESPACE}`, {
      auth,
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    const socket = socketRef.current;

    // Connection events
    socket.on('connect', () => {
      console.log('[Socket] Connected:', socket.id);
      setIsConnected(true);
      onConnect?.();
    });

    socket.on('disconnect', (reason) => {
      console.log('[Socket] Disconnected:', reason);
      setIsConnected(false);
      onDisconnect?.();
    });

    socket.on('connect_error', (error) => {
      console.error('[Socket] Connection error:', error.message);
    });

    // Notification event
    socket.on('notification', (notification: NotificationData) => {
      console.log('[Socket] Received notification:', notification);
      onNotification?.(notification);
    });

    // Cleanup on unmount
    return () => {
      socket.disconnect();
      socketRef.current = null;
      setIsConnected(false);
    };
  }, [enabled, tenantId, userId, clientId, token, onNotification, onConnect, onDisconnect]);

  const subscribe = useCallback((types: string[]) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('subscribe', { types });
    }
  }, []);

  const unsubscribe = useCallback((types: string[]) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('unsubscribe', { types });
    }
  }, []);

  const markAsRead = useCallback((notificationId: string) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('markAsRead', { notificationId });
    }
  }, []);

  const markAllAsRead = useCallback(() => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('markAllAsRead');
    }
  }, []);

  return {
    socket: socketRef.current,
    isConnected,
    subscribe,
    unsubscribe,
    markAsRead,
    markAllAsRead,
  };
}

// Export types
export type { NotificationData, UseSocketOptions, UseSocketReturn };
