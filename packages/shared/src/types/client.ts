import { BaseEntity, ContactInfo, ClientStatus } from './common';

export interface Client extends BaseEntity {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  dateOfBirth?: Date;
  gender?: 'male' | 'female' | 'other' | 'prefer_not_to_say';
  profileImage?: string;
  status: ClientStatus;
  preferences: ClientPreferences;
  loyalty: LoyaltyInfo;
  history: ClientHistory;
  notes: ClientNote[];
  tags: string[];
  source: string; // How they found the salon (referral, google, etc.)
  firstVisit: Date;
  lastVisit?: Date;
  totalSpent: number;
  visitCount: number;
  averageSpent: number;
  preferredProfessionals: string[];
  allergies?: string[];
  medicalConditions?: string[];
  communication: CommunicationPreferences;
}

export interface ClientPreferences {
  preferredServices: string[];
  preferredProfessionals: string[];
  preferredTimes: {
    timeOfDay: 'morning' | 'afternoon' | 'evening';
    dayOfWeek: number[]; // 0-6
  };
  language: 'es' | 'en';
  notifications: {
    email: boolean;
    sms: boolean;
    whatsapp: boolean;
    push: boolean;
  };
  booking: {
    allowNotifications: boolean;
    autoConfirm: boolean;
    requireApproval: boolean;
  };
}

export interface LoyaltyInfo {
  programId?: string;
  points: number;
  tier: 'bronze' | 'silver' | 'gold' | 'platinum';
  joinDate: Date;
  totalEarned: number;
  totalRedeemed: number;
  nextTierPoints: number;
  benefits: LoyaltyBenefit[];
  transactions: LoyaltyTransaction[];
}

export interface LoyaltyBenefit {
  benefitId: string;
  name: string;
  description: string;
  type: 'discount' | 'free_service' | 'bonus_points' | 'priority_booking';
  value: number;
  isActive: boolean;
  expiresAt?: Date;
}

export interface LoyaltyTransaction {
  id: string;
  type: 'earn' | 'redeem' | 'expire' | 'bonus';
  points: number;
  description: string;
  appointmentId?: string;
  createdAt: Date;
  expiresAt?: Date;
}

export interface ClientHistory {
  firstAppointment?: Date;
  lastAppointment?: Date;
  totalAppointments: number;
  completedAppointments: number;
  cancelledAppointments: number;
  noShowAppointments: number;
  favoriteServices: Array<{
    serviceId: string;
    serviceName: string;
    count: number;
    lastVisit: Date;
  }>;
  averageInterval: number; // days between visits
  lastService?: {
    serviceId: string;
    serviceName: string;
    date: Date;
    professionalId: string;
  };
}

export interface ClientNote {
  id: string;
  content: string;
  createdBy: string; // professionalId
  createdAt: Date;
  isPrivate: boolean; // only staff can see
  tags: string[];
}

export interface CommunicationPreferences {
  preferredChannel: 'email' | 'sms' | 'whatsapp' | 'phone';
  marketingOptIn: boolean;
  appointmentReminders: boolean;
  promotionsOptIn: boolean;
  birthdayOffers: boolean;
  feedbackRequests: boolean;
  newsletterOptIn: boolean;
}

export interface CreateClientDto {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  dateOfBirth?: Date;
  gender?: 'male' | 'female' | 'other' | 'prefer_not_to_say';
  source?: string;
  preferredLanguage?: 'es' | 'en';
  allergies?: string[];
  medicalConditions?: string[];
  notes?: string;
}

export interface UpdateClientDto extends Partial<CreateClientDto> {
  status?: ClientStatus;
  preferences?: Partial<ClientPreferences>;
  communication?: Partial<CommunicationPreferences>;
  tags?: string[];
  preferredProfessionals?: string[];
}

export interface ClientSegment {
  id: string;
  name: string;
  description: string;
  criteria: ClientSegmentCriteria;
  clientCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientSegmentCriteria {
  visitCount?: {
    operator: 'gte' | 'lte' | 'eq';
    value: number;
  };
  totalSpent?: {
    operator: 'gte' | 'lte' | 'eq';
    value: number;
  };
  lastVisit?: {
    operator: 'gte' | 'lte' | 'eq';
    days: number;
  };
  status?: ClientStatus[];
  tags?: string[];
  services?: string[];
  preferredProfessionals?: string[];
}

export interface ClientStats {
  totalClients: number;
  activeClients: number;
  newClientsThisMonth: number;
  returningClientsThisMonth: number;
  averageLifetimeValue: number;
  averageVisitFrequency: number; // days
  topReferralSources: Array<{
    source: string;
    count: number;
    percentage: number;
  }>;
  clientRetentionRate: number; // percentage
}