// components/calendar/calendar.service.ts
import apiClient, { Appointment, Professional as ApiProfessional, Client, Service, AppointmentService } from '../../lib/api';

// Extended appointment type that includes populated relationships
interface PopulatedAppointment extends Appointment {
  client?: Client;
  service?: Service;
  professional?: ApiProfessional;
  services?: AppointmentService[];
}

export const fetchCalendarData = async (tenantId: string, date: Date) => {
  try {
    // Fetch appointments for the selected date
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);
    
      const appointments = await apiClient.getAppointments({
        tenantId,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
      });
      
      // Fetch professionals for the tenant
      const professionals = await apiClient.getProfessionalsPublic(tenantId);
    
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

export const transformToCalendarFormat = (
  backendAppointments: PopulatedAppointment[],
  backendProfessionals: ApiProfessional[]
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
    
    // If the service name contains "lunch" or "break", mark as lunch
    if (appointment.service && typeof appointment.service === 'object') {
      if (appointment.service.name.toLowerCase().includes('lunch') ||
          appointment.service.name.toLowerCase().includes('break')) {
        type = "lunch";
      }
    }
    
    // Handle multi-service appointments with different professionals
    if (appointment.services && appointment.services.length > 1) {
      // Create separate calendar appointments for each service/professional combination
      const appointmentStart = new Date(`${datePart}T${appointment.scheduledTime}:00`);
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
          professionalId,
          clientName,
          serviceName,
          start: startDateTime.toISOString(),
          end: endDateTime.toISOString(),
          type,
          isMultiService: true,
          status: appointment.status,
          appointmentServiceId: serviceAppointment.id,
        });
        
        // Move current time forward for the next serial service
        if (!serviceAppointment.isParallel) {
          currentTime = endDateTime.getTime();
        }
      });
    } else {
      // Single service appointment
      const totalDuration = calculateTotalDuration(appointment);
      const startDateTime = new Date(`${datePart}T${appointment.scheduledTime}:00`);
      const endDateTime = new Date(startDateTime.getTime() + totalDuration * 60000);
      
      let serviceName: string | undefined;
      if (appointment.service && typeof appointment.service === 'object') {
        serviceName = appointment.service.name;
      }
      
      calendarAppointments.push({
        id: appointment.id,
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
    avatarUrl: professional.profileImage || `https://i.pravatar.cc/150?u=${professional.id}`,
  }));
  
  return { appointments: calendarAppointments, professionals: calendarProfessionals };
};