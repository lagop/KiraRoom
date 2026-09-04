'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Bell, Check, CheckCheck, X, Calendar, CreditCard, Megaphone, AlertCircle, MessageSquare, Clock, Loader2 } from 'lucide-react'
import apiClient from '@/lib/api'
import type { Notification, NotificationType } from '@/lib/api'
import { useSocket, NotificationData } from '@/src/hooks/useSocket'

const NOTIFICATIONS_PER_PAGE = 10

// Helper function to get relative time
function getRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)

  if (diffInSeconds < 60) {
    return 'Ahora mismo'
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60)
  if (diffInMinutes < 60) {
    return `Hace ${diffInMinutes} minuto${diffInMinutes > 1 ? 's' : ''}`
  }

  const diffInHours = Math.floor(diffInMinutes / 60)
  if (diffInHours < 24) {
    return `Hace ${diffInHours} hora${diffInHours > 1 ? 's' : ''}`
  }

  const diffInDays = Math.floor(diffInHours / 24)
  if (diffInDays < 7) {
    return `Hace ${diffInDays} día${diffInDays > 1 ? 's' : ''}`
  }

  const diffInWeeks = Math.floor(diffInDays / 7)
  if (diffInWeeks < 4) {
    return `Hace ${diffInWeeks} semana${diffInWeeks > 1 ? 's' : ''}`
  }

  return date.toLocaleDateString('es-ES')
}

// Get icon based on notification type
function getNotificationIcon(type: NotificationType) {
  switch (type) {
    case 'appointment_created':
    case 'appointment_reminder':
    case 'appointment_confirmed':
    case 'appointment_completed':
    case 'new_appointment_assigned':
    case 'schedule_change':
      return { icon: Calendar, color: 'text-blue-500 bg-blue-100' }
    case 'appointment_cancelled':
      return { icon: X, color: 'text-red-500 bg-red-100' }
    case 'payment_received':
    case 'refund_processed':
      return { icon: CreditCard, color: 'text-green-500 bg-green-100' }
    case 'payment_failed':
      return { icon: CreditCard, color: 'text-red-500 bg-red-100' }
    case 'promotion':
    case 'special_offer':
      return { icon: Megaphone, color: 'text-purple-500 bg-purple-100' }
    case 'system_alert':
    case 'account_update':
    case 'password_change':
      return { icon: AlertCircle, color: 'text-amber-500 bg-amber-100' }
    case 'new_message':
      return { icon: MessageSquare, color: 'text-indigo-500 bg-indigo-100' }
    case 'review_request':
      return { icon: Check, color: 'text-teal-500 bg-teal-100' }
    case 'news':
      return { icon: Megaphone, color: 'text-sky-500 bg-sky-100' }
    default:
      return { icon: Bell, color: 'text-gray-500 bg-gray-100' }
  }
}

interface NotificationItemProps {
  notification: Notification
  onMarkAsRead: (id: string) => void
}

function NotificationItem({ notification, onMarkAsRead }: NotificationItemProps) {
  const { icon: Icon, color } = getNotificationIcon(notification.type)

  const handleClick = async () => {
    if (!notification.isRead) {
      await onMarkAsRead(notification.id)
    }
    // Don't close the popup - let user browse notifications
  }

  return (
    <div
      onClick={handleClick}
      className={`flex items-start gap-3 p-3 hover:bg-gray-50 cursor-pointer transition-colors ${
        !notification.isRead ? 'bg-purple-100 border-l-4 border-purple-500' : 'bg-white'
      }`}
    >
      <div className={`flex-shrink-0 p-2 rounded-full ${color}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {!notification.isRead && (
            <span className="flex-shrink-0 w-2 h-2 bg-purple-500 rounded-full" />
          )}
          <p className={`text-sm truncate ${!notification.isRead ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
            {notification.title}
          </p>
        </div>
        <p className="text-xs text-gray-500 truncate mt-0.5">
          {notification.message}
        </p>
        <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {getRelativeTime(notification.createdAt)}
        </p>
      </div>
    </div>
  )
}

interface ClientNotificationBellProps {
  clientId: string
  tenantId?: string
}

export function ClientNotificationBell({ clientId, tenantId }: ClientNotificationBellProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [totalCount, setTotalCount] = useState(0)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Handle real-time notifications from socket
  const handleSocketNotification = useCallback((notification: NotificationData) => {
    console.log('[ClientNotificationBell] Received real-time notification:', notification)
    
    // Add the new notification to the list
    setNotifications(prev => [notification as Notification, ...prev])
    
    // Increment unread count
    setUnreadCount(prev => prev + 1)
  }, [])

  // Connect to socket for real-time notifications
  const { isConnected } = useSocket({
    clientId,
    tenantId: tenantId || '',
    onNotification: handleSocketNotification,
    enabled: !!clientId && !!tenantId,
  })

  // Fetch initial notifications
  const fetchNotifications = useCallback(async () => {
    if (!clientId) {
      console.log('[ClientNotificationBell] No clientId provided, skipping fetch')
      return
    }
    try {
      setLoading(true)
      setError(null)
      console.log('[ClientNotificationBell] Fetching notifications for clientId:', clientId)
      const response = await apiClient.getClientNotifications(clientId, { limit: NOTIFICATIONS_PER_PAGE, offset: 0 })
      console.log('[ClientNotificationBell] Response:', response)
      setNotifications(response?.data ?? [])
      setUnreadCount(response?.unreadCount ?? 0)
      setTotalCount(response?.total ?? 0)
      setHasMore((response?.data?.length ?? 0) < (response?.total ?? 0))
    } catch (err) {
      console.error('[ClientNotificationBell] Failed to fetch notifications:', err)
      setError('Error al cargar notificaciones')
      setNotifications([])
      setUnreadCount(0)
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }, [clientId])

  // Fetch more notifications (for infinite scroll)
  const fetchMoreNotifications = useCallback(async () => {
    if (!clientId || loadingMore || !hasMore) return
    
    try {
      setLoadingMore(true)
      const offset = notifications.length
      console.log('[ClientNotificationBell] Fetching more notifications, offset:', offset)
      const response = await apiClient.getClientNotifications(clientId, { 
        limit: NOTIFICATIONS_PER_PAGE, 
        offset 
      })
      
      if (response?.data && response.data.length > 0) {
        setNotifications(prev => [...prev, ...response.data])
        setHasMore(notifications.length + response.data.length < (response?.total ?? 0))
      } else {
        setHasMore(false)
      }
    } catch (err) {
      console.error('[ClientNotificationBell] Failed to fetch more notifications:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [clientId, notifications.length, loadingMore, hasMore])

  const fetchUnreadCount = useCallback(async () => {
    if (!clientId) {
      console.log('[ClientNotificationBell] No clientId provided, skipping unread count fetch')
      return
    }
    try {
      console.log('[ClientNotificationBell] Fetching unread count for clientId:', clientId)
      const response = await apiClient.getClientUnreadNotificationCount(clientId)
      console.log('[ClientNotificationBell] Unread count response:', response)
      setUnreadCount(response?.count ?? 0)
    } catch (err) {
      console.error('[ClientNotificationBell] Failed to fetch unread count:', err)
      setUnreadCount(0)
    }
  }, [clientId])

  // Handle scroll for infinite loading
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    const scrollBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    
    // Load more when user is 100px from the bottom
    if (scrollBottom < 100 && hasMore && !loadingMore) {
      fetchMoreNotifications()
    }
  }, [hasMore, loadingMore, fetchMoreNotifications])

  useEffect(() => {
    fetchUnreadCount()
    // Poll for new notifications every 60 seconds as a fallback
    // Real-time updates are handled by socket.io
    const interval = setInterval(fetchUnreadCount, 60000)
    return () => clearInterval(interval)
  }, [fetchUnreadCount])

  useEffect(() => {
    if (isOpen) {
      // Reset pagination state when opening
      setNotifications([])
      setHasMore(true)
      fetchNotifications()
    }
  }, [isOpen, fetchNotifications])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        bellRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        !bellRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleMarkAsRead = async (id: string) => {
    if (!clientId) return
    try {
      await apiClient.markClientNotificationAsRead(clientId, id)
      setNotifications(prev =>
        prev.map(n => (n.id === id ? { ...n, isRead: true } : n))
      )
      setUnreadCount(prev => Math.max(0, prev - 1))
    } catch (err) {
      console.error('Failed to mark notification as read:', err)
    }
  }

  const handleMarkAllAsRead = async () => {
    if (!clientId) return
    try {
      await apiClient.markAllClientNotificationsAsRead(clientId)
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })))
      setUnreadCount(0)
    } catch (err) {
      console.error('Failed to mark all notifications as read:', err)
    }
  }

  return (
    <div className="relative">
      <button
        ref={bellRef}
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 rounded-full hover:bg-purple-100 transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2"
        aria-label="Notificaciones"
      >
        <Bell className="h-5 w-5 text-gray-600" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-xs font-bold text-white bg-purple-500 rounded-full">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="absolute right-0 mt-2 w-80 sm:w-96 bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden z-50"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gradient-to-r from-purple-500 to-pink-500">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white">Notificaciones</h3>
              {totalCount > 0 && (
                <span className="text-xs text-white/70">({totalCount})</span>
              )}
            </div>
            {unreadCount > 0 && (
              <button
                onClick={handleMarkAllAsRead}
                className="flex items-center gap-1 text-xs text-white/90 hover:text-white transition-colors"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Marcar todas leídas
              </button>
            )}
          </div>

          {/* Content with infinite scroll */}
          <div 
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="max-h-[400px] overflow-y-auto"
          >
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-purple-500" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-8 px-4">
                <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
                <p className="text-sm text-gray-500">{error}</p>
                <button
                  onClick={fetchNotifications}
                  className="mt-2 text-sm text-purple-600 hover:text-purple-700 font-medium"
                >
                  Reintentar
                </button>
              </div>
            ) : !notifications || notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 px-4">
                <Bell className="h-8 w-8 text-gray-300 mb-2" />
                <p className="text-sm text-gray-500">No tienes notificaciones</p>
              </div>
            ) : (
              <>
                <div className="divide-y divide-gray-100">
                  {notifications.map(notification => (
                    <NotificationItem
                      key={notification.id}
                      notification={notification}
                      onMarkAsRead={handleMarkAsRead}
                    />
                  ))}
                </div>
                
                {/* Loading more indicator */}
                {loadingMore && (
                  <div className="flex items-center justify-center py-4 border-t border-gray-100">
                    <Loader2 className="h-5 w-5 animate-spin text-purple-500" />
                    <span className="ml-2 text-sm text-gray-500">Cargando más...</span>
                  </div>
                )}
                
                {/* End of list indicator */}
                {!hasMore && notifications.length > 0 && (
                  <div className="flex items-center justify-center py-3 border-t border-gray-100">
                    <span className="text-xs text-gray-400">No hay más notificaciones</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
