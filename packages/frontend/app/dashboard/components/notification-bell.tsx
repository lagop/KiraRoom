'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, CheckCheck, AlertCircle, Clock, Loader2 } from 'lucide-react'
import apiClient from '../../../lib/api'
import type { Notification } from '../../../lib/api'
import Link from 'next/link'
import { useSocket, NotificationData } from '@/src/hooks/useSocket'
import { useTranslations } from '@/lib/use-translation'
import { formatRelativeTime, notificationHref } from '@/lib/notification-display'
import { getNotificationIcon } from './notification-icon'

const NOTIFICATIONS_PER_PAGE = 10

type Translate = ReturnType<typeof useTranslations>

interface NotificationItemProps {
  notification: Notification
  onMarkAsRead: (id: string) => void
  onOpen: (href: string) => void
  t: Translate
}

function NotificationItem({ notification, onMarkAsRead, onOpen, t }: NotificationItemProps) {
  const { icon: Icon, color } = getNotificationIcon(notification.type)
  const href = notificationHref(notification)

  // Marks it read and, when it is about something (an appointment, a
  // time-off answer), opens it. It used to only mark it read.
  const handleClick = async () => {
    if (!notification.isRead) {
      await onMarkAsRead(notification.id)
    }
    if (href) onOpen(href)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }}
      className={`flex items-start gap-3 p-3 hover:bg-gray-50 cursor-pointer transition-colors ${
        !notification.isRead ? 'bg-indigo-100 border-l-4 border-indigo-500' : 'bg-white'
      }`}
    >
      <div className={`flex-shrink-0 p-2 rounded-full ${color}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {!notification.isRead && (
            <span className="flex-shrink-0 w-2 h-2 bg-indigo-500 rounded-full" />
          )}
          <p className={`text-sm truncate ${!notification.isRead ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
            {notification.title}
          </p>
        </div>
        {/* Up to three lines: a refusal's "Motivo: …" used to be cut off. */}
        <p className="text-xs text-gray-500 line-clamp-3 mt-0.5 break-words">
          {notification.message}
        </p>
        <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {formatRelativeTime(notification.createdAt, t)}
        </p>
      </div>
    </div>
  )
}

export function NotificationBell() {
  const t = useTranslations()
  const router = useRouter()
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

  // Get user info from localStorage for socket connection
  const [userInfo, setUserInfo] = useState<{ id: string; tenantId: string } | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Dashboard stores user info in 'user' key, not 'kira_user'
      const userStr = localStorage.getItem('user')
      if (userStr) {
        try {
          const user = JSON.parse(userStr)
          setUserInfo({ id: user.id, tenantId: user.tenantId })
        } catch (e) {
          console.error('Failed to parse user info:', e)
        }
      }
    }
  }, [])

  // Handle real-time notifications from socket
  const handleSocketNotification = useCallback((notification: NotificationData) => {
    console.log('[NotificationBell] Received real-time notification:', notification)
    
    // Add the new notification to the list
    setNotifications(prev => [notification as Notification, ...prev])
    
    // Increment unread count
    setUnreadCount(prev => prev + 1)
  }, [])

  // Connect to socket for real-time notifications
  const { isConnected } = useSocket({
    userId: userInfo?.id,
    tenantId: userInfo?.tenantId || '',
    token: typeof window !== 'undefined' ? localStorage.getItem('kira_auth_token') || undefined : undefined,
    onNotification: handleSocketNotification,
    enabled: !!userInfo?.tenantId,
  })

  // Fetch initial notifications
  const fetchNotifications = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const response = await apiClient.getNotifications({ limit: NOTIFICATIONS_PER_PAGE, offset: 0 })
      setNotifications(response?.data ?? [])
      setUnreadCount(response?.unreadCount ?? 0)
      setTotalCount(response?.total ?? 0)
      setHasMore((response?.data?.length ?? 0) < (response?.total ?? 0))
    } catch (err) {
      console.error('Failed to fetch notifications:', err)
      setError('load_error')
      setNotifications([])
      setUnreadCount(0)
      setHasMore(false)
    } finally {
      setLoading(false)
    }
  }, [])

  // Fetch more notifications (for infinite scroll)
  const fetchMoreNotifications = useCallback(async () => {
    if (loadingMore || !hasMore) return
    
    try {
      setLoadingMore(true)
      const offset = notifications.length
      const response = await apiClient.getNotifications({ 
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
      console.error('Failed to fetch more notifications:', err)
    } finally {
      setLoadingMore(false)
    }
  }, [notifications.length, loadingMore, hasMore])

  const fetchUnreadCount = useCallback(async () => {
    try {
      const response = await apiClient.getUnreadNotificationCount()
      setUnreadCount(response?.count ?? 0)
    } catch (err) {
      console.error('Failed to fetch unread count:', err)
      setUnreadCount(0)
    }
  }, [])

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
    try {
      await apiClient.markNotificationAsRead(id)
      setNotifications(prev =>
        prev.map(n => (n.id === id ? { ...n, isRead: true } : n))
      )
      setUnreadCount(prev => Math.max(0, prev - 1))
    } catch (err) {
      console.error('Failed to mark notification as read:', err)
    }
  }

  const handleMarkAllAsRead = async () => {
    try {
      await apiClient.markAllNotificationsAsRead()
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })))
      setUnreadCount(0)
    } catch (err) {
      console.error('Failed to mark all notifications as read:', err)
    }
  }

  return (
    <div className="relative flex-shrink-0">
      <button
        ref={bellRef}
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 rounded-full hover:bg-gray-100 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        aria-label={t('notifications.bell_label')}
        title={t('notifications.bell_label')}
      >
        <Bell className="h-5 w-5 text-gray-600" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] px-1 text-xs font-bold text-white bg-red-500 rounded-full">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="fixed inset-x-3 top-14 mt-0 sm:absolute sm:inset-auto sm:right-0 sm:mt-2 sm:top-auto sm:w-96 w-auto max-w-[calc(100vw-24px)] bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden z-50"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gradient-to-r from-indigo-500 to-purple-500">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-white">{t('notifications.title')}</h3>
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
                {t('notifications.mark_all_read')}
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
                <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-8 px-4">
                <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
                <p className="text-sm text-gray-500">{t('notifications.load_error')}</p>
                <button
                  onClick={fetchNotifications}
                  className="mt-2 text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  {t('notifications.retry')}
                </button>
              </div>
            ) : !notifications || notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 px-4">
                <Bell className="h-8 w-8 text-gray-300 mb-2" />
                <p className="text-sm text-gray-500">{t('notifications.empty')}</p>
              </div>
            ) : (
              <>
                <div className="divide-y divide-gray-100">
                  {notifications.map(notification => (
                    <NotificationItem
                      key={notification.id}
                      notification={notification}
                      onMarkAsRead={handleMarkAsRead}
                      onOpen={(href) => {
                        setIsOpen(false)
                        router.push(href)
                      }}
                      t={t}
                    />
                  ))}
                </div>
                
                {/* Loading more indicator */}
                {loadingMore && (
                  <div className="flex items-center justify-center py-4 border-t border-gray-100">
                    <Loader2 className="h-5 w-5 animate-spin text-indigo-500" />
                    <span className="ml-2 text-sm text-gray-500">{t('notifications.loading_more')}</span>
                  </div>
                )}
                
                {/* End of list indicator */}
                {!hasMore && notifications.length > 0 && (
                  <div className="flex items-center justify-center py-3 border-t border-gray-100">
                    <span className="text-xs text-gray-400">{t('notifications.no_more')}</span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          {notifications && notifications.length > 0 && (
            <div className="border-t border-gray-200 bg-gray-50">
              <Link
                href="/dashboard/notifications"
                onClick={() => setIsOpen(false)}
                className="block w-full text-center py-2.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 hover:bg-gray-100 transition-colors"
              >
                {t('notifications.view_all')}
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
