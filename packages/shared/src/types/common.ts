// Common types used across the application

export interface BaseEntity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  tenantId: string; // Multi-tenant support
}

export interface PaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  errors?: Record<string, string[]>;
}

export interface TimeSlot {
  start: Date;
  end: Date;
}

export interface DaySchedule {
  dayOfWeek: number; // 0-6, Sunday = 0
  isOpen: boolean;
  openTime?: string; // HH:mm format
  closeTime?: string; // HH:mm format
  breaks?: TimeSlot[];
}

export enum UserRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  STAFF = 'staff',
  CLIENT = 'client'
}

export enum AppointmentStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show'
}

export enum ClientStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  BLOCKED = 'blocked'
}

export enum ServiceCategory {
  HAIR = 'hair',
  NAILS = 'nails',
  FACIAL = 'facial',
  MASSAGE = 'massage',
  BODY = 'body',
  OTHER = 'other'
}

export enum PaymentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  FAILED = 'failed',
  REFUNDED = 'refunded'
}

export enum AppointmentSource {
  ONLINE = 'online',
  PHONE = 'phone',
  WALK_IN = 'walk_in',
  STAFF = 'staff',
  WIDGET = 'widget',
  INSTAGRAM = 'instagram'
}

export enum AppointmentLocation {
  SALON = 'salon',
  CLIENT_HOME = 'client_home',
  OTHER = 'other'
}

export enum NotificationChannel {
  EMAIL = 'email',
  SMS = 'sms',
  WHATSAPP = 'whatsapp',
  PUSH = 'push'
}

export interface ContactInfo {
  email?: string;
  phone?: string;
  whatsapp?: string;
}

export interface Address {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}