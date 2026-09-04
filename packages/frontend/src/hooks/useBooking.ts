import { useState, useCallback } from 'react';
import apiClient from '@/lib/api';

// Types matching our backend structure
interface Service {
  id: string;
  name: string;
  description?: string;
  duration: number;
  price: number;
  currency: string;
  category: string;
  isActive: boolean;
}

interface Professional {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  specialties: string[];
  isActive: boolean;
}

interface Appointment {
  id: string;
  clientId: string;
  serviceId: string;
  professionalId: string;
  scheduledDate: string;
  scheduledTime: string;
  duration: number;
  status: 'pending' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';
  price: number;
  notes?: string;
}

interface Client {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
}

interface ClientData {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  language: 'es' | 'en';
}

interface BookingState {
  selectedService: Service | null;
  selectedProfessional: Professional | null;
  selectedDate: string;
  selectedTime: string;
  clientData: ClientData;
  isLoading: boolean;
  error: string | null;
}

interface UseBookingReturn extends BookingState {
  actions: {
    selectService: (service: Service) => void;
    selectProfessional: (professional: Professional) => void;
    selectDateTime: (date: string, time: string) => void;
    updateClientData: (data: Partial<ClientData>) => void;
    resetBooking: () => void;
    createBooking: (tenantId: string) => Promise<Appointment | null>;
    getAvailableSlots: (tenantId: string, professionalId: string, serviceId: string, date: string) => Promise<string[]>;
  };
}

const initialState: BookingState = {
  selectedService: null,
  selectedProfessional: null,
  selectedDate: '',
  selectedTime: '',
  clientData: {
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    language: 'es',
  },
  isLoading: false,
  error: null,
};

export const useBooking = (): UseBookingReturn => {
  const [state, setState] = useState<BookingState>(initialState);

  const selectService = useCallback((service: Service) => {
    setState(prev => ({
      ...prev,
      selectedService: service,
      selectedProfessional: null,
      selectedDate: '',
      selectedTime: '',
      error: null,
    }));
  }, []);

  const selectProfessional = useCallback((professional: Professional) => {
    setState(prev => ({
      ...prev,
      selectedProfessional: professional,
      selectedDate: '',
      selectedTime: '',
      error: null,
    }));
  }, []);

  const selectDateTime = useCallback((date: string, time: string) => {
    setState(prev => ({
      ...prev,
      selectedDate: date,
      selectedTime: time,
      error: null,
    }));
  }, []);

  const updateClientData = useCallback((data: Partial<ClientData>) => {
    setState(prev => ({
      ...prev,
      clientData: { ...prev.clientData, ...data },
      error: null,
    }));
  }, []);

  const resetBooking = useCallback(() => {
    setState(initialState);
  }, []);

  const getAvailableSlots = useCallback(async (
    tenantId: string,
    professionalId: string,
    serviceId: string,
    date: string
  ): Promise<string[]> => {
    try {
      // Call real backend API for available slots
      const response = await apiClient.getAvailableSlots(
        tenantId,
        professionalId,
        serviceId,
        date
      );

      // Filter only available slots and return time strings
      return response
        .filter(slot => slot.isAvailable)
        .map(slot => slot.time);

    } catch (error) {
      console.error('Error fetching available slots:', error);
      throw new Error('No se pudieron obtener los horarios disponibles');
    }
  }, []);

  const createBooking = useCallback(async (tenantId: string): Promise<Appointment | null> => {
    if (!state.selectedService || !state.selectedProfessional || !state.selectedDate || !state.selectedTime) {
      setState(prev => ({ ...prev, error: 'Faltan datos para crear la reserva' }));
      return null;
    }

    if (!state.clientData.firstName || !state.clientData.lastName || !state.clientData.email || !state.clientData.phone) {
      setState(prev => ({ ...prev, error: 'Información del cliente incompleta' }));
      return null;
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      // Create client first
      const client = await apiClient.createClient({
        tenantId,
        firstName: state.clientData.firstName,
        lastName: state.clientData.lastName,
        email: state.clientData.email,
        phone: state.clientData.phone,
      });

      // Create appointment
      const appointment = await apiClient.createAppointment({
        tenantId,
        clientId: client.id,
        serviceId: state.selectedService.id,
        professionalId: state.selectedProfessional.id,
        scheduledDate: state.selectedDate,
        scheduledTime: state.selectedTime,
        notes: '',
      });

      setState(prev => ({ ...prev, isLoading: false }));
      return appointment;

    } catch (error) {
      setState(prev => ({ 
        ...prev, 
        isLoading: false, 
        error: 'Error al crear la reserva. Inténtalo de nuevo.' 
      }));
      return null;
    }
  }, [state]);

  return {
    ...state,
    actions: {
      selectService,
      selectProfessional,
      selectDateTime,
      updateClientData,
      resetBooking,
      createBooking,
      getAvailableSlots,
    },
  };
};

export default useBooking;