'use client'

import { useState, useEffect, useCallback } from 'react'
import { Bell, Check, CheckCheck, X, Calendar, CreditCard, Megaphone, AlertCircle, MessageSquare, Clock, Loader2, Filter, ArrowLeft } from 'lucide-react'
import apiClient from '@/lib/api'
import type { Notification, NotificationType } from '@/lib/api'
import Link from 'next/link'

const NOTIFICATIONS_PER_PAGE = 20

// Helper function to get relative time
function getRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)

  if (diffInSeconds < 60) {
    return 'Just now'
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60)
  if (diffInMinutes < 60) {
    return `${diffInMinutes} minute${diffInMinutes > 1 ? 's' : ''} ago`
  }

  const diffInHours = Math.floor(diffInMinutes / 60)
  if (diffInHours < 24) {
    return `${diffInHours} hour${diffInHours > 1 ? 's' : ''} ago`
  }

  const diffInDays = Math.floor(diffInHours / 24)
  if (diffInDays < 7) {
    return `${diffInDays} day${diffInDays > 1 ? 's' : ''} ago`
  }

  const diffInWeeks = Math.floor(diffInDays / 7)
  if (diffInWeeks < 4) {
    return `${diffInWeeks} week${diffInWeeks > 1 ? 's' : ''} ago`
  }

  return date.toLocaleDateString()
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

// Get type label
function getTypeLabel(type: NotificationType): string {
  switch (type) {
    case 'appointment_created':
      return 'New Appointment'
    case 'appointment_reminder':
      return 'Reminder'
    case 'appointment_confirmed':
      return 'Confirmed'
    case 'appointment_completed':
      return 'Completed'
    case 'appointment_cancelled':
      return 'Cancelled'
    case 'new_appointment_assigned':
      return 'New Assignment'
    case 'schedule_change':
      return 'Schedule Change'
    case 'payment_received':
      return 'Payment'
    case 'payment_failed':
      return 'Payment Failed'
    case 'refund_processed':
      return 'Refund'
    case 'promotion':
    case 'special_offer':
      return 'Promotion'
    case 'system_alert':
      return 'System'
    case 'account_update':
      return 'Account'
    case 'password_change':
      return 'Security'
    case 'new_message':
      return 'Message'
    case 'review_request':
      return 'Review'
    case 'news':
      return 'News'
    default:
      return 'Notification'
  }
}

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [filter, setFilter] = useState<'all' | 'unread'>('all')

  // Fetch notifications
  const fetchNotifications = useCallback(async (reset = false) => {
    try {
      if (reset) {
        setLoading(true)
        setNotifications([])
      }
      setError(null)
      
      const response = await apiClient.getNotifications({ 
        limit: NOTIFICATIONS_PER_PAGE, 
        offset: reset ? 0 : notifications.length,
        unreadOnly: filter === 'unread'
      })
      
      if (reset) {
        setNotifications(response?.data ?? [])
      } else {
        setNotifications(prev => [...prev, ...(response?.data ?? [])])
      }
      setUnreadCount(response?.unreadCount ?? 0)
      setTotalCount(response?.total ?? 0)
      setHasMore((response?.data?.length ?? 0) >= NOTIFICATIONS_PER_PAGE)
    } catch (err) {
      console.error('Failed to fetch notifications:', err)
      setError('Failed to load notifications')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [filter, notifications.length])

  // Fetch more notifications
  const fetchMoreNotifications = useCallback(async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    await fetchNotifications(false)
  }, [loadingMore, hasMore, fetchNotifications])

  // Initial fetch and filter change
  useEffect(() => {
    fetchNotifications(true)
  }, [filter])

  // Handle scroll for infinite loading
  useEffect(() => {
    const handleScroll = () => {
      if (
        window.innerHeight + document.documentElement.scrollTop >=
          document.documentElement.offsetHeight - 200 &&
        hasMore &&
        !loadingMore &&
        !loading
      ) {
        fetchMoreNotifications()
      }
    }

    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [hasMore, loadingMore, loading, fetchMoreNotifications])

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
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 py-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <Link
                href="/dashboard"
                className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <ArrowLeft className="h-5 w-5 text-gray-600" />
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-gray-900 truncate">Notifications</h1>
                <p className="text-sm text-gray-500 mt-1">
                  {totalCount} total{unreadCount > 0 && `, ${unreadCount} unread`}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Filter */}
              <div className="flex items-center gap-2 bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setFilter('all')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    filter === 'all'
                      ? 'bg-white text-indigo-600 shadow-sm'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  All
                </button>
                <button
                  onClick={() => setFilter('unread')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    filter === 'unread'
                      ? 'bg-white text-indigo-600 shadow-sm'
                      : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  Unread
                  {unreadCount > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-indigo-100 text-indigo-600 rounded-full">
                      {unreadCount}
                    </span>
                  )}
                </button>
              </div>
              
              {/* Mark all read */}
              {unreadCount > 0 && (
                <button
                  onClick={handleMarkAllAsRead}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors"
                >
                  <CheckCheck className="h-4 w-4" />
                  Mark all read
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12">
            <AlertCircle className="h-12 w-12 text-red-400 mb-4" />
            <p className="text-lg text-gray-600">{error}</p>
            <button
              onClick={() => fetchNotifications(true)}
              className="mt-4 px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors"
            >
              Try again
            </button>
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Bell className="h-12 w-12 text-gray-300 mb-4" />
            <p className="text-lg text-gray-500">
              {filter === 'unread' ? 'No unread notifications' : 'No notifications yet'}
            </p>
            {filter === 'unread' && (
              <button
                onClick={() => setFilter('all')}
                className="mt-4 text-sm text-indigo-600 hover:text-indigo-700 font-medium"
              >
                View all notifications
              </button>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="divide-y divide-gray-100">
              {notifications.map(notification => {
                const { icon: Icon, color } = getNotificationIcon(notification.type)
                
                return (
                  <div
                    key={notification.id}
                    className={`flex items-start gap-4 p-4 hover:bg-gray-50 transition-colors ${
                      !notification.isRead ? 'bg-indigo-100 border-l-4 border-indigo-500' : ''
                    }`}
                  >
                    <div className={`flex-shrink-0 p-2.5 rounded-full ${color}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            {!notification.isRead && (
                              <span className="flex-shrink-0 w-2 h-2 bg-indigo-500 rounded-full" />
                            )}
                            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                              {getTypeLabel(notification.type)}
                            </span>
                          </div>
                          <h3 className={`text-base ${!notification.isRead ? 'font-semibold text-gray-900' : 'text-gray-700'}`}>
                            {notification.title}
                          </h3>
                          <p className="text-sm text-gray-500 mt-1">
                            {notification.message}
                          </p>
                        </div>
                        
                        <div className="flex-shrink-0 text-right">
                          <p className="text-xs text-gray-400 flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {getRelativeTime(notification.createdAt)}
                          </p>
                          {!notification.isRead && (
                            <button
                              onClick={() => handleMarkAsRead(notification.id)}
                              className="mt-2 text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                            >
                              Mark as read
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
            
            {/* Loading more indicator */}
            {loadingMore && (
              <div className="flex items-center justify-center py-6 border-t border-gray-100">
                <Loader2 className="h-5 w-5 animate-spin text-indigo-500" />
                <span className="ml-2 text-sm text-gray-500">Loading more...</span>
              </div>
            )}
            
            {/* End of list */}
            {!hasMore && notifications.length > 0 && (
              <div className="flex items-center justify-center py-6 border-t border-gray-100 bg-gray-50">
                <span className="text-sm text-gray-400">You've reached the end</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
