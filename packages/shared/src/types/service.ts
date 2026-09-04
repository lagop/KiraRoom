import { BaseEntity, ServiceCategory } from './common';

export interface Service extends BaseEntity {
  name: string;
  description?: string;
  category: ServiceCategory;
  duration: number; // Duration in minutes
  price: number;
  currency: string;
  isActive: boolean;
  requiresApproval: boolean;
  maxAdvanceBooking: number; // Days in advance this service can be booked
  minAdvanceBooking: number; // Hours in advance this service can be booked
  bufferTime: number; // Minutes after service before next booking
  isOnlineBookable: boolean;
  isMobile: boolean; // Service can be done at client's location
  images?: string[];
  prerequisites?: string[]; // Other services required before this one
  staff: string[]; // Staff IDs who can perform this service
  equipment?: string[]; // Required equipment
  products?: ServiceProduct[]; // Products used in this service
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
}

export interface ServiceProduct {
  productId: string;
  quantity: number;
  cost: number; // Cost per unit
}

export interface ServiceCategoryEntity extends BaseEntity {
  name: string;
  description?: string;
  category: ServiceCategory;
  color?: string;
  icon?: string;
  isActive: boolean;
  sortOrder: number;
}

export interface CreateServiceDto {
  name: string;
  description?: string;
  category: ServiceCategory;
  duration: number;
  price: number;
  currency: string;
  requiresApproval?: boolean;
  maxAdvanceBooking?: number;
  minAdvanceBooking?: number;
  bufferTime?: number;
  isOnlineBookable?: boolean;
  isMobile?: boolean;
  images?: string[];
  prerequisites?: string[];
  staff?: string[];
  equipment?: string[];
  products?: ServiceProduct[];
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
}

export interface UpdateServiceDto extends Partial<CreateServiceDto> {
  isActive?: boolean;
}

export interface CreateServiceCategoryDto {
  name: string;
  description?: string;
  category: ServiceCategory;
  color?: string;
  icon?: string;
  sortOrder?: number;
}

export interface UpdateServiceCategoryDto extends Partial<CreateServiceCategoryDto> {
  isActive?: boolean;
}

export interface ServiceAvailability {
  serviceId: string;
  staffId: string;
  date: Date;
  timeSlots: TimeSlot[];
}

export interface TimeSlot {
  start: string; // HH:mm format
  end: string; // HH:mm format
  isAvailable: boolean;
  appointmentId?: string; // If slot is booked
}

// Service pricing variations (for different staff, durations, etc.)
export interface ServiceVariation {
  id: string;
  serviceId: string;
  name: string;
  duration: number; // minutes
  price: number;
  isDefault: boolean;
}

export interface ServiceAddon {
  id: string;
  serviceId: string;
  name: string;
  description?: string;
  price: number;
  duration: number; // additional minutes
  isRequired: boolean;
  maxQuantity: number;
}