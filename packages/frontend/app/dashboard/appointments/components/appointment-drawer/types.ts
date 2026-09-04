/**
 * Shared types for the appointment drawer.
 *
 * Verbatim move of `Appointment`, `AvailableTimeSlot`, `Professional`,
 * `PopulatedAppointment`, `AppointmentStatus`, and `AppointmentDrawerProps`
 * from `appointment-drawer.tsx:59-227`. Centralised so the new
 * hooks / section components can share a single source of truth.
 *
 * No behaviour change — every field is identical to the original
 * inline definitions.
 */

export type AppointmentStatus =
  | "confirmed"
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export interface PopulatedAppointment {
  client: {
    id: string;
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
  };
  professional: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    specialties: string[];
  };
  service: {
    id: string;
    name: string;
    description?: string;
    duration: number;
    price: number;
  };
  // Multi-service support
  services?: Array<{
    id: string;
    service: {
      id: string;
      name: string;
      description?: string;
      duration: number;
      price: number;
    };
    professional?: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      specialties: string[];
    };
    isParallel: boolean;
    scheduledStart?: string;
    scheduledEnd?: string;
  }>;
}

export interface Professional {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  specialties: string[];
  profileImage?: string;
  services?: {
    serviceId: string;
    service: {
      id: string;
      name: string;
      category: string;
    };
  }[];
}

export interface AvailableTimeSlot {
  time: string;
  available: boolean;
}

export interface Appointment {
  id: string;
  client: {
    id: string;
    name: string;
    email: string;
    phone: string;
  };
  professional: {
    id: string;
    name: string;
    email: string;
    phone: string;
    specialty: string;
  };
  service: {
    id: string;
    name: string;
    description: string;
    duration: number;
    price: number;
  };
  // Multi-service support
  services?: Array<{
    id: string;
    service: {
      id: string;
      name: string;
      description?: string;
      duration: number;
      price: number;
    };
    professional?: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      phone?: string;
      specialties: string[];
    };
    isParallel: boolean;
    scheduledStart?: string;
    scheduledEnd?: string;
  }>;
  addons: Array<{
    id: string;
    name: string;
    quantity: number;
    price: number;
    duration: number;
  }>;
  rawAddons?: any; // Raw backend data for transformation
  date: string;
  time: string;
  status: AppointmentStatus;
  price: number;
  notes: string;
  commissionRate?: number;
  createdAt: string;
  updatedAt: string;
  activity?: Array<{
    timestamp: string;
    action: string;
    details?: string;
  }>;
}

export interface AppointmentDrawerProps {
  appointmentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAppointmentUpdated?: () => void;
  refreshKey?: number;
}

/**
 * `transformAddons` and the other drawer-specific helpers live in
 * `appointment-drawer.utils.ts`. The Appointment type was moved here
 * as part of the Phase 1/2 refactor (re-exports the original
 * inline interface verbatim so behaviour is preserved).
 */