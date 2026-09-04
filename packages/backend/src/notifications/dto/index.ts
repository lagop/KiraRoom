import { IsString, IsOptional, IsEnum, IsObject, IsBoolean, IsUUID, IsArray, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

// Notification type enum - must match Prisma schema
export enum NotificationType {
  // Appointment related
  APPOINTMENT_CREATED = 'appointment_created',
  APPOINTMENT_CONFIRMED = 'appointment_confirmed',
  APPOINTMENT_CANCELLED = 'appointment_cancelled',
  APPOINTMENT_RESCHEDULED = 'appointment_rescheduled',
  APPOINTMENT_REMINDER_24H = 'appointment_reminder_24h',
  APPOINTMENT_REMINDER_1H = 'appointment_reminder_1h',
  APPOINTMENT_COMPLETED = 'appointment_completed',
  APPOINTMENT_NO_SHOW = 'appointment_no_show',
  REVIEW_REQUEST = 'review_request',
  
  // Payment related
  PAYMENT_RECEIVED = 'payment_received',
  PAYMENT_FAILED = 'payment_failed',
  REFUND_PROCESSED = 'refund_processed',
  
  // Promotional
  PROMOTION = 'promotion',
  NEWS = 'news',
  SPECIAL_OFFER = 'special_offer',
  
  // System
  SYSTEM_ALERT = 'system_alert',
  ACCOUNT_UPDATE = 'account_update',
  PASSWORD_CHANGE = 'password_change',
  
  // Professional specific
  NEW_APPOINTMENT_ASSIGNED = 'new_appointment_assigned',
  SCHEDULE_CHANGE = 'schedule_change',
  NEW_MESSAGE = 'new_message',
}

export class CreateNotificationDto {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsEnum(NotificationType)
  type: NotificationType;

  @IsString()
  title: string;

  @IsString()
  message: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, any>;
}

export class UpdateNotificationDto {
  @IsOptional()
  @IsBoolean()
  isRead?: boolean;
}

export class NotificationFilterDto {
  @IsOptional()
  @IsBoolean()
  isRead?: boolean;

  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  offset?: number;
}

export class NotificationPreferenceDto {
  @IsObject()
  preferences: Record<string, {
    inApp?: boolean;
    email?: boolean;
    sms?: boolean;
    whatsapp?: boolean;
  }>;
}

export class BulkNotificationDto {
  @IsUUID()
  tenantId: string;

  @IsEnum(NotificationType)
  type: NotificationType;

  @IsString()
  title: string;

  @IsString()
  message: string;

  @IsOptional()
  @IsObject()
  data?: Record<string, any>;

  @IsOptional()
  @IsArray()
  clientIds?: string[];

  @IsOptional()
  @IsArray()
  userIds?: string[];

  @IsOptional()
  @IsBoolean()
  sendToAllClients?: boolean;
}

export class MarkAllReadDto {
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;
}
