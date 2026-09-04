import { BaseEntity, ContactInfo, DaySchedule } from './common';

export interface Professional extends BaseEntity {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  profileImage?: string;
  bio?: string;
  specialties: string[];
  isActive: boolean;
  isOwner: boolean;
  position: string;
  commissionRate?: number; // Percentage commission on services
  hireDate: Date;
  terminationDate?: Date;
  workingHours: DaySchedule[];
  services: string[]; // Service IDs this professional can perform
  availability: ProfessionalAvailability;
  settings: ProfessionalSettings;
  stats: ProfessionalStats;
}

export interface ProfessionalAvailability {
  timeZone: string;
  maxDailyHours: number;
  breakTimes: BreakTime[];
  unavailableDates: UnavailableDate[];
  customAvailability: CustomAvailability[];
}

export interface BreakTime {
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  label: string;
}

export interface UnavailableDate {
  date: Date;
  reason: string;
  isAllDay: boolean;
  startTime?: string;
  endTime?: string;
}

export interface CustomAvailability {
  date: Date;
  isAvailable: boolean;
  availableHours?: CustomHours[];
}

export interface CustomHours {
  startTime: string; // HH:mm
  endTime: string; // HH:mm
}

export interface ProfessionalSettings {
  allowOnlineBooking: boolean;
  requireApproval: boolean;
  maxAdvanceBooking: number; // days
  minAdvanceBooking: number; // hours
  bufferTime: number; // minutes
  allowDoubleBooking: boolean;
  autoConfirmBookings: boolean;
  notifyNewBookings: boolean;
}

export interface ProfessionalStats {
  totalAppointments: number;
  completedAppointments: number;
  cancelledAppointments: number;
  noShowAppointments: number;
  averageRating: number;
  totalRevenue: number;
  averageServiceTime: number; // minutes
  clientRetentionRate: number; // percentage
  lastActivity?: Date;
}

export interface CreateProfessionalDto {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  bio?: string;
  specialties: string[];
  position: string;
  commissionRate?: number;
  hireDate: Date;
  workingHours: DaySchedule[];
  services: string[];
  profileImage?: string;
}

export interface UpdateProfessionalDto extends Partial<CreateProfessionalDto> {
  isActive?: boolean;
  terminationDate?: Date;
  availability?: Partial<ProfessionalAvailability>;
  settings?: Partial<ProfessionalSettings>;
}

export interface ProfessionalSchedule {
  professionalId: string;
  date: Date;
  timeSlots: ScheduleSlot[];
  breaks: BreakTime[];
  totalHours: number;
  availableHours: number;
}

export interface ScheduleSlot {
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  isAvailable: boolean;
  isBooked: boolean;
  appointmentId?: string;
  serviceId?: string;
  clientId?: string;
  clientName?: string;
}

export interface ProfessionalPerformance {
  professionalId: string;
  period: {
    start: Date;
    end: Date;
  };
  metrics: {
    appointmentsCompleted: number;
    appointmentsCancelled: number;
    noShowRate: number;
    averageRating: number;
    totalRevenue: number;
    commissionEarned: number;
    clientSatisfaction: number;
    punctualityScore: number;
  };
  topServices: Array<{
    serviceId: string;
    serviceName: string;
    count: number;
    revenue: number;
  }>;
}