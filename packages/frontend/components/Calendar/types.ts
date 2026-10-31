// components/calendar/types.ts
export type Professional = {
  id: string;
  name: string;
  avatarUrl?: string;
  /** Staff are sent the salon's inactive professionals too. */
  isActive?: boolean;
  /** `[{ day: "monday", openTime: "09:00", closeTime: "18:00" }]`, when known. */
  workingHours?: unknown[];
};

export type Appointment = {
  /** The block's id: the appointment's, or "<appointmentId>-<index>" per service. */
  id: string;
  /** The appointment it belongs to (block ids cannot be parsed: UUIDs have dashes). */
  appointmentId?: string;
  professionalId: string;
  clientName?: string;
  serviceName?: string;
  start: string; // ISO
  end: string; // ISO
  type: "appointment" | "lunch" | "blocked";
  isMultiService?: boolean;
  status?: string;
  appointmentServiceId?: string; // ID of the AppointmentService for multi-service appointments
  /** Runs alongside the other services of the visit (e.g. while a colour sets). */
  isParallel?: boolean;
  notes?: string;
  depositRequired?: boolean;
  depositAmount?: number;
  commissionRate?: number;
};

export type TimeSlot = {
  hour: number;
  minute: number;
};
