// components/calendar/types.ts
export type Professional = {
  id: string;
  name: string;
  avatarUrl?: string;
};

export type Appointment = {
  id: string;
  professionalId: string;
  clientName?: string;
  serviceName?: string;
  start: string; // ISO
  end: string; // ISO
  type: "appointment" | "lunch" | "blocked";
  isMultiService?: boolean;
  status?: string;
  appointmentServiceId?: string; // ID of the AppointmentService for multi-service appointments
  notes?: string;
  depositRequired?: boolean;
  depositAmount?: number;
  commissionRate?: number;
};

export type TimeSlot = {
  hour: number;
  minute: number;
};
