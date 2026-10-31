// components/calendar/calendar.service.ts
import apiClient, { Appointment, Professional as ApiProfessional, Client, Service, AppointmentService } from '../../lib/api';
import { dayQueryRange, FALLBACK_SALON_TIMEZONE, salonInstant } from './salon-time';
import { isBreakService } from './day-grid';

// Extended appointment type that includes populated relationships
interface PopulatedAppointment extends Appointment {
  client?: Client;
  service?: Service;
  professional?: ApiProfessional;
  services?: AppointmentService[];
}

// The salon is the caller's, from the token: no tenantId is sent.
// `day` ("YYYY-MM-DD") is a day of the salon's calendar.
export const fetchCalendarData = async (day: string) => {
  try {
    const [appointments, professionals] = await Promise.all([
      apiClient.getAppointments(dayQueryRange(day)),
      apiClient.getProfessionalsPublic(),
    ]);

    return { appointments, professionals };
  } catch (error) {
    console.error('Error fetching calendar data:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Error stack:', error.stack);
    }
    throw error;
  }
};

export interface SalonSettings {
  /** The salon's own zone (Tenant.timezone): the calendar draws its clock. */
  timeZone: string;
  /** Tenant.openingHours: one `{ open, close }` for the week, when set. */
  openingHours: { open?: unknown; close?: unknown } | null;
}

/** What the calendar needs from the salon, asked for once. */
export const fetchSalonSettings = async (): Promise<SalonSettings> => {
  try {
    const tenant = await apiClient.getTenant();
    const hours = tenant.openingHours;
    return {
      timeZone: tenant.timezone || FALLBACK_SALON_TIMEZONE,
      openingHours: hours && typeof hours === 'object' ? (hours as SalonSettings['openingHours']) : null,
    };
  } catch (error) {
    console.error('Error fetching the salon settings:', error);
    return { timeZone: FALLBACK_SALON_TIMEZONE, openingHours: null };
  }
};

// Helper to calculate total duration for multi-service appointments
const calculateTotalDuration = (appointment: PopulatedAppointment): number => {
  // If no multi-services, return single service duration
  if (!appointment.services || appointment.services.length === 0) {
    return appointment.duration || 0;
  }
  
  // Separate parallel and serial services
  const parallelServices = appointment.services.filter(s => s.isParallel);
  const serialServices = appointment.services.filter(s => !s.isParallel);
  
  // For serial services: sum all durations
  const serialDuration = serialServices.reduce((sum, s) => sum + (s.service?.duration || 0), 0);
  
  // For parallel services: take the max duration
  const parallelDuration = parallelServices.length > 0 
    ? Math.max(...parallelServices.map(s => s.service?.duration || 0))
    : 0;
  
  return serialDuration + parallelDuration;
};

/**
 * Calendar blocks from the server's appointments. Every block's start and end
 * are real instants: an appointment's day and "HH:MM" are read on the salon's
 * clock (`timeZone`), as the server does, never on the browser's.
 */
export const transformToCalendarFormat = (
  backendAppointments: PopulatedAppointment[],
  backendProfessionals: ApiProfessional[],
  timeZone: string,
) => {
  // Transform backend appointments to Calendar format
  const calendarAppointments: any[] = [];
  
  backendAppointments.forEach(appointment => {
    // Extract just the date part from the ISO string (YYYY-MM-DD)
    const datePart = appointment.scheduledDate.split('T')[0];
    
    // Get client name
    let clientName: string | undefined;
    if (appointment.client && typeof appointment.client === 'object') {
      clientName = `${appointment.client.firstName} ${appointment.client.lastName}`;
    }
    
    // Determine appointment type
    let type: "appointment" | "lunch" | "blocked" = "appointment";
    
    // A lunch or a break, by the service's name (in Spanish or English).
    if (appointment.service && typeof appointment.service === 'object' && isBreakService(appointment.service.name)) {
      type = "lunch";
    }
    
    // Handle multi-service appointments with different professionals
    if (appointment.services && appointment.services.length > 1) {
      // Create separate calendar appointments for each service/professional combination
      const appointmentStart = salonInstant(datePart, appointment.scheduledTime, timeZone);
      let currentTime = appointmentStart.getTime();
      
      // First pass: identify parallel and serial services
      const parallelServices = appointment.services.filter(s => s.isParallel);
      const serialServices = appointment.services.filter(s => !s.isParallel);
      
      // Calculate the max duration for parallel services
      const parallelMaxDuration = parallelServices.length > 0
        ? Math.max(...parallelServices.map(s => s.service?.duration || 0))
        : 0;
      
      // Process all services
      appointment.services.forEach((serviceAppointment, index) => {
        const serviceDuration = serviceAppointment.service?.duration || 0;
        const professionalId = serviceAppointment.professionalId || appointment.professionalId;
        const serviceName = serviceAppointment.service?.name || 'Unknown';
        
        // Use scheduledStart and scheduledEnd if they exist, otherwise calculate from duration
        let startDateTime: Date;
        let endDateTime: Date;
        
        if (serviceAppointment.scheduledStart && serviceAppointment.scheduledEnd) {
          startDateTime = new Date(serviceAppointment.scheduledStart);
          endDateTime = new Date(serviceAppointment.scheduledEnd);
        } else {
          if (serviceAppointment.isParallel) {
            // Parallel services all start at the same time
            startDateTime = new Date(appointmentStart);
            endDateTime = new Date(startDateTime.getTime() + serviceDuration * 60000);
          } else {
            // Serial services start after previous serial services
            startDateTime = new Date(currentTime);
            endDateTime = new Date(startDateTime.getTime() + serviceDuration * 60000);
          }
        }
        
        calendarAppointments.push({
          id: `${appointment.id}-${index}`,
          appointmentId: appointment.id,
          professionalId,
          clientName,
          serviceName,
          start: startDateTime.toISOString(),
          end: endDateTime.toISOString(),
          type,
          isMultiService: true,
          status: appointment.status,
          appointmentServiceId: serviceAppointment.id,
          isParallel: !!serviceAppointment.isParallel,
        });
        
        // Move current time forward for the next serial service
        if (!serviceAppointment.isParallel) {
          currentTime = endDateTime.getTime();
        }
      });
    } else {
      // Single service appointment
      const totalDuration = calculateTotalDuration(appointment);
      const startDateTime = salonInstant(datePart, appointment.scheduledTime, timeZone);
      const endDateTime = new Date(startDateTime.getTime() + totalDuration * 60000);
      
      let serviceName: string | undefined;
      if (appointment.service && typeof appointment.service === 'object') {
        serviceName = appointment.service.name;
      }
      
      calendarAppointments.push({
        id: appointment.id,
        appointmentId: appointment.id,
        professionalId: appointment.professionalId,
        clientName,
        serviceName,
        start: startDateTime.toISOString(),
        end: endDateTime.toISOString(),
        type,
        isMultiService: false,
        status: appointment.status,
      });
    }
  });
  
  // Transform backend professionals to Calendar format
  const calendarProfessionals = backendProfessionals.map(professional => ({
    id: professional.id,
    name: `${professional.firstName} ${professional.lastName}`,
    // No stock face for a professional without a photo: the avatar falls back
    // to initials. This used to load a random stranger from i.pravatar.cc,
    // sending each professional id to that third party.
    avatarUrl: professional.profileImage || undefined,
    isActive: professional.isActive,
    // Staff receive the full row, with the hours the onboarding stores.
    workingHours: Array.isArray((professional as any).workingHours) ? (professional as any).workingHours : undefined,
  }));
  
  return { appointments: calendarAppointments, professionals: calendarProfessionals };
};