// Notification data types for type-safe data field
// These types define the shape of the `data` JSON field per notification type

export interface BaseNotificationData {
  tenantId: string;
}

// Appointment notifications
export interface AppointmentCreatedData extends BaseNotificationData {
  appointmentId: string;
  serviceId: string;
  serviceName: string;
  professionalId: string;
  professionalName: string;
  date: string;
  time: string;
}

export interface AppointmentReminderData extends BaseNotificationData {
  appointmentId: string;
  serviceId: string;
  serviceName: string;
  professionalName: string;
  date: string;
  time: string;
  hoursUntil: number; // 24 or 1
}

export interface AppointmentCancelledData extends BaseNotificationData {
  appointmentId: string;
  serviceName: string;
  date: string;
  time: string;
  reason?: string;
}

export interface AppointmentConfirmedData extends BaseNotificationData {
  appointmentId: string;
  serviceName: string;
  professionalName: string;
  date: string;
  time: string;
}

export interface AppointmentCompletedData extends BaseNotificationData {
  appointmentId: string;
  serviceName: string;
  professionalName: string;
  date: string;
}

export interface ReviewRequestData extends BaseNotificationData {
  appointmentId: string;
  serviceId: string;
  serviceName: string;
  professionalId: string;
  professionalName: string;
}

// Payment notifications
export interface PaymentReceivedData extends BaseNotificationData {
  paymentId: string;
  appointmentId: string;
  amount: number;
  currency: string;
}

export interface PaymentFailedData extends BaseNotificationData {
  appointmentId: string;
  amount: number;
  currency: string;
  reason?: string;
}

export interface RefundProcessedData extends BaseNotificationData {
  refundId: string;
  appointmentId: string;
  amount: number;
  currency: string;
}

// Promotional notifications
export interface PromotionData extends BaseNotificationData {
  promotionId: string;
  title: string;
  code?: string;
  discount?: string;
  validUntil?: string;
}

export interface NewsData extends BaseNotificationData {
  newsId: string;
  title: string;
  summary?: string;
}

export interface SpecialOfferData extends BaseNotificationData {
  offerId: string;
  title: string;
  description?: string;
  code?: string;
  validUntil?: string;
}

// System notifications
export interface SystemAlertData extends BaseNotificationData {
  alertId: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface AccountUpdateData extends BaseNotificationData {
  updateType: string;
  message: string;
}

export interface PasswordChangeData extends BaseNotificationData {
  changedAt: string;
}

// Professional specific notifications
export interface NewAppointmentAssignedData extends BaseNotificationData {
  appointmentId: string;
  clientId: string;
  clientName: string;
  serviceName: string;
  date: string;
  time: string;
}

export interface ScheduleChangeData extends BaseNotificationData {
  scheduleId: string;
  changeType: 'added' | 'removed' | 'modified';
  date: string;
  details?: string;
}

export interface NewMessageData extends BaseNotificationData {
  messageId: string;
  fromId: string;
  fromName: string;
  preview: string;
}

// Union type for all notification data
export type NotificationData =
  | AppointmentCreatedData
  | AppointmentReminderData
  | AppointmentCancelledData
  | AppointmentConfirmedData
  | AppointmentCompletedData
  | ReviewRequestData
  | PaymentReceivedData
  | PaymentFailedData
  | RefundProcessedData
  | PromotionData
  | NewsData
  | SpecialOfferData
  | SystemAlertData
  | AccountUpdateData
  | PasswordChangeData
  | NewAppointmentAssignedData
  | ScheduleChangeData
  | NewMessageData;
