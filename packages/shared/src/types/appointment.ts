import { BaseEntity, AppointmentStatus, PaymentStatus, AppointmentSource, AppointmentLocation } from './common';

export interface Appointment extends BaseEntity {
  clientId: string;
  client?: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
  serviceId: string;
  service?: {
    name: string;
    duration: number;
    price: number;
    category: string;
  };
  professionalId: string;
  professional?: {
    firstName: string;
    lastName: string;
  };
  scheduledDate: Date;
  scheduledTime: string; // HH:mm format
  duration: number; // minutes
  endTime: string; // HH:mm format
  status: AppointmentStatus;
  price: number;
  currency: string;
  paymentStatus: PaymentStatus;
  paymentMethod?: string;
  stripePaymentIntentId?: string;
  notes?: string;
  internalNotes?: string;
  cancellationReason?: string;
  cancellationPolicy?: string;
  isRecurring: boolean;
  recurringSeriesId?: string;
  parentAppointmentId?: string;
  childAppointments?: string[];
  reminders: AppointmentReminder[];
  checkInTime?: Date;
  startTime?: Date;
  completionTime?: Date;
  addons: AppointmentAddon[];
  discount?: AppointmentDiscount;
  taxes: AppointmentTax[];
  totalAmount: number;
  amountPaid: number;
  amountDue: number;
  source: AppointmentSource;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  rating?: number;
  review?: string;
  feedback?: ClientFeedback;
  location: AppointmentLocation;
  address?: string;
  travelFee?: number;
  depositRequired: boolean;
  depositAmount?: number;
  depositPaid: boolean;
  depositPaymentIntentId?: string;
}

export interface AppointmentAddon {
  addonId: string;
  name: string;
  price: number;
  duration: number; // additional minutes
  quantity: number;
}

export interface AppointmentDiscount {
  type: 'percentage' | 'fixed';
  value: number;
  code?: string;
  reason: string;
  appliedBy?: string; // staffId who applied discount
}

export interface AppointmentTax {
  name: string;
  rate: number; // percentage
  amount: number;
}

export interface AppointmentReminder {
  id: string;
  type: 'confirmation' | 'reminder' | 'follow_up';
  channel: 'email' | 'sms' | 'whatsapp';
  scheduledFor: Date;
  sentAt?: Date;
  status: 'pending' | 'sent' | 'failed';
  message?: string;
}

export interface ClientFeedback {
  rating: number; // 1-5 stars
  review?: string;
  serviceRating?: number;
  professionalRating?: number;
  salonRating?: number;
  wouldRecommend: boolean;
  submittedAt: Date;
  response?: string;
  respondedAt?: Date;
}

export interface CreateAppointmentDto {
  clientId?: string;
  clientInfo?: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
  serviceId: string;
  professionalId?: string; // if not provided, will be assigned automatically
  scheduledDate: Date;
  scheduledTime: string;
  notes?: string;
  addons?: Array<{
    addonId: string;
    quantity: number;
  }>;
  discount?: {
    type: 'percentage' | 'fixed';
    value: number;
    code?: string;
    reason: string;
  };
  paymentMethod?: 'card' | 'cash' | 'deposit';
  depositRequired?: boolean;
  location?: AppointmentLocation;
  address?: string;
  source?: AppointmentSource;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

export interface UpdateAppointmentDto {
  serviceId?: string;
  professionalId?: string;
  scheduledDate?: Date;
  scheduledTime?: string;
  notes?: string;
  status?: AppointmentStatus;
  addons?: Array<{
    addonId: string;
    quantity: number;
  }>;
  discount?: {
    type: 'percentage' | 'fixed';
    value: number;
    code?: string;
    reason: string;
  };
  cancellationReason?: string;
}

export interface AppointmentSearch {
  clientId?: string;
  professionalId?: string;
  serviceId?: string;
  status?: AppointmentStatus[];
  dateFrom?: Date;
  dateTo?: Date;
  minPrice?: number;
  maxPrice?: number;
  source?: string[];
  paymentStatus?: PaymentStatus[];
  tags?: string[];
  hasRating?: boolean;
}

export interface AppointmentSlot {
  date: Date;
  time: string; // HH:mm
  professionalId: string;
  serviceId: string;
  duration: number;
  price: number;
  isAvailable: boolean;
  isBooked: boolean;
  appointmentId?: string;
  clientId?: string;
}

export interface RecurringAppointment {
  id: string;
  appointmentId: string;
  frequency: 'weekly' | 'biweekly' | 'monthly';
  interval: number; // every N weeks/months
  daysOfWeek?: number[]; // for weekly
  endDate?: Date;
  maxOccurrences?: number;
  isActive: boolean;
  createdAt: Date;
}

export interface AppointmentStats {
  totalAppointments: number;
  completedAppointments: number;
  cancelledAppointments: number;
  noShowAppointments: number;
  rescheduledAppointments: number;
  revenue: number;
  averageRating: number;
  topServices: Array<{
    serviceId: string;
    serviceName: string;
    count: number;
    revenue: number;
  }>;
  topProfessionals: Array<{
    professionalId: string;
    professionalName: string;
    count: number;
    revenue: number;
  }>;
  hourlyDistribution: Array<{
    hour: number;
    count: number;
    percentage: number;
  }>;
  dailyDistribution: Array<{
    day: number;
    count: number;
    percentage: number;
  }>;
  monthlyGrowth: Array<{
    month: string;
    appointments: number;
    revenue: number;
  }>;
}