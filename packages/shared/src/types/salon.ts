import { BaseEntity, ContactInfo, Address, DaySchedule } from './common';

export interface Salon extends BaseEntity {
  name: string;
  slug: string; // For subdomain/custom domain
  description?: string;
  logo?: string;
  coverImage?: string;
  website?: string;
  contact: ContactInfo;
  address: Address;
  settings: SalonSettings;
  subscription: SalonSubscription;
  features: SalonFeatures;
}

export interface SalonSettings {
  timezone: string;
  currency: string;
  language: 'es' | 'en';
  dateFormat: string;
  timeFormat: '12h' | '24h';
  workingHours: DaySchedule[];
  bookingSettings: BookingSettings;
  notificationSettings: NotificationSettings;
  businessSettings: BusinessSettings;
}

export interface BookingSettings {
  advanceBookingDays: number; // How many days in advance can clients book
  cancellationPolicy: CancellationPolicy;
  requireApproval: boolean; // Require manual approval for bookings
  allowOnlineCancellation: boolean;
  allowOnlineRescheduling: boolean;
  maxAdvanceBooking: number; // Maximum days in advance
  minAdvanceBooking: number; // Minimum hours in advance
  bufferTime: number; // Minutes between appointments
}

export interface CancellationPolicy {
  advanceNotice: number; // Hours before appointment
  penaltyPercentage?: number; // Percentage penalty for late cancellation
  penaltyAmount?: number; // Fixed penalty amount
  refundPolicy: 'full' | 'partial' | 'none';
}

export interface NotificationSettings {
  confirmation: {
    email: boolean;
    sms: boolean;
    whatsapp: boolean;
  };
  reminders: {
    email: boolean;
    sms: boolean;
    whatsapp: boolean;
    hoursBefore: number[];
  };
  cancellation: {
    email: boolean;
    sms: boolean;
    whatsapp: boolean;
  };
}

export interface BusinessSettings {
  allowGuestBookings: boolean; // Allow bookings without account
  collectClientInfo: boolean;
  requireClientPhone: boolean;
  requireClientEmail: boolean;
  allowReviews: boolean;
  autoConfirmBookings: boolean;
}

export interface SalonSubscription {
  plan: 'basic' | 'professional' | 'advanced';
  status: 'active' | 'cancelled' | 'past_due' | 'trialing';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEnd?: Date;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
}

export interface SalonFeatures {
  // Basic Plan Features
  onlineBooking: boolean;
  basicReporting: boolean;
  emailNotifications: boolean;
  
  // Professional Plan Features
  smsNotifications: boolean;
  whatsappIntegration: boolean;
  crm: boolean;
  loyaltyProgram: boolean;
  automatedMarketing: boolean;
  advancedReporting: boolean;
  chatbot: boolean;
  
  // Advanced Plan Features
  multiLocation: boolean;
  staffManagement: boolean;
  inventory: boolean;
  pos: boolean;
  advancedAnalytics: boolean;
  api: boolean;
  integrations: boolean;
  ai: boolean;
}

export interface CreateSalonDto {
  name: string;
  slug: string;
  description?: string;
  website?: string;
  contact: ContactInfo;
  address: Address;
  timezone: string;
  currency: string;
  language: 'es' | 'en';
}

export interface UpdateSalonDto extends Partial<CreateSalonDto> {
  settings?: Partial<SalonSettings>;
}