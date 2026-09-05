'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Calendar, Clock, Scissors, User, ChevronRight } from 'lucide-react';
import apiClient from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';

interface BookingData {
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  serviceId: string;
  professionalId: string;
  date: string;
  time: string;
}

interface SalonData {
  id: string;
  name: string;
  description: string;
  address: string;
  phone: string;
  email: string;
  logo: string;
}

interface Professional {
  id: string;
  tenantId: string;
  firstName: string;
  lastName: string;
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

interface Service {
  id: string;
  name: string;
  description?: string;
  duration: number;
  price: number;
  category: string;
  isActive: boolean;
}

interface AvailableTimeSlot {
  time: string;
  available: boolean;
}

interface UserData {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: string;
}

export default function NewAppointmentPage({ params }: { params: { salonName: string } }) {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [salonData, setSalonData] = useState<SalonData | null>(null);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [availableSlots, setAvailableSlots] = useState<AvailableTimeSlot[]>([]);
  const [showAllServices, setShowAllServices] = useState(false);
  const [showAllProfessionals, setShowAllProfessionals] = useState(false);
  const [bookingData, setBookingData] = useState<BookingData>({
    clientName: '',
    clientEmail: '',
    clientPhone: '',
    serviceId: '',
    professionalId: '',
    date: '',
    time: '',
  });
  const [currentUser, setCurrentUser] = useState<UserData | null>(null);
  
  // Pre-fill service and professional from URL params
  useEffect(() => {
    const serviceId = searchParams?.get('serviceId');
    const professionalId = searchParams?.get('professionalId');
    if (serviceId || professionalId) {
      setBookingData(prev => ({
        ...prev,
        serviceId: serviceId || prev.serviceId,
        professionalId: professionalId || prev.professionalId,
      }));
    }
  }, [searchParams]);

  // Check if user is already logged in on component mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const userStr = localStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        setCurrentUser(user);
        // Auto-fill booking data with user information
        setBookingData(prev => ({
          ...prev,
          clientName: `${user.firstName} ${user.lastName}`,
          clientEmail: user.email,
          clientPhone: user.phone || '',
        }));
      }
    }
  }, []);

  // Set default date to today + 1 day
  useEffect(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setBookingData(prev => ({
      ...prev,
      date: tomorrow.toISOString().split('T')[0],
    }));
  }, []);

  // Fetch salon data, professionals, and services
  useEffect(() => {
    const fetchSalonData = async () => {
      try {
        setLoading(true);
        
        // Fetch professionals first to get the tenant ID
        let professionalsData: Professional[] = [];
        try {
          professionalsData = await apiClient.getProfessionalsPublic();
          setProfessionals(professionalsData);
        } catch (error) {
          console.error('Error fetching professionals:', error);
        }
        
        // Use the tenantId from the first professional if available
        const tenantId = professionalsData.length > 0 ? professionalsData[0].tenantId : null;
        
        // Set salon data with the actual tenant ID
        const mockSalon: SalonData = {
          id: tenantId || 'default',
          name: params.salonName.charAt(0).toUpperCase() + params.salonName.slice(1),
          description: 'Tu salón de belleza de confianza en el corazón de la ciudad.',
          address: 'Calle Principal 123, Local 4',
          phone: '+34 123 456 789',
          email: 'info@kiraroom.com',
          logo: '/api/placeholder/100/100',
        };
        
        setSalonData(mockSalon);
        
        try {
          const servicesData = await apiClient.getServices();
          setServices(servicesData);
        } catch (error) {
          console.error('Error fetching services:', error);
          toast({
            title: 'Error',
            description: 'No se pudo cargar los servicios',
            variant: 'destructive',
          });
        }
      } catch (error) {
        console.error('Error fetching salon data:', error);
        toast({
          title: 'Error',
          description: 'No se pudo cargar la información del salón',
          variant: 'destructive',
        });
      } finally {
        setLoading(false);
      }
    };

    fetchSalonData();
  }, [params.salonName]);

  // Fetch available time slots
  useEffect(() => {
    const fetchAvailableSlots = async () => {
      // Only fetch slots if service and professional are selected
      if (!bookingData.professionalId || !bookingData.serviceId || !bookingData.date) {
        setAvailableSlots([]);
        return;
      }

      try {
        // TODO: Implement API endpoint for available slots
        // For now, use consistent available slots for all professionals
        const mockSlots: AvailableTimeSlot[] = [];
        
        // Get current date and time for comparison
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        
        for (let hour = 9; hour <= 19; hour++) {
          for (let minute = 0; minute < 60; minute += 30) {
            const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            
            // Check if this slot is in the past (only for today)
            let isPast = false;
            if (bookingData.date === today) {
              if (hour < currentHour || (hour === currentHour && minute <= currentMinute)) {
                isPast = true;
              }
            }
            
            mockSlots.push({
              time: timeStr,
              available: !isPast, // Mark past slots as unavailable
            });
          }
        }
        
        setAvailableSlots(mockSlots);
      } catch (error) {
        console.error('Error fetching available slots:', error);
        toast({
          title: 'Error',
          description: 'No se pudo cargar los horarios disponibles',
          variant: 'destructive',
        });
      }
    };

    // Debounce fetching slots
    const timer = setTimeout(() => {
      fetchAvailableSlots();
    }, 300);

    return () => clearTimeout(timer);
  }, [bookingData.professionalId, bookingData.serviceId, bookingData.date]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    
    // Always clear time slots when changing service or professional
    if (name === 'serviceId' || name === 'professionalId') {
      setAvailableSlots([]);
      
      if (name === 'serviceId') {
        // Clear professional and time when service changes
        setBookingData(prev => ({
          ...prev,
          serviceId: value,
          professionalId: '',
          time: '',
        }));
      } else {
        // Just update the professional and clear time
        setBookingData(prev => ({
          ...prev,
          professionalId: value,
          time: '',
        }));
      }
    } else {
      setBookingData(prev => ({
        ...prev,
        [name]: value,
      }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Get the selected service to get duration and price
      const selectedService = services.find(s => s.id === bookingData.serviceId);
      
      const appointmentData = {
        tenantId: salonData?.id || '1',
        // Always send clientInfo - the backend will find or create the client
        clientInfo: {
          firstName: currentUser ? currentUser.firstName : bookingData.clientName.split(' ')[0],
          lastName: currentUser ? currentUser.lastName : bookingData.clientName.split(' ').slice(1).join(' '),
          email: currentUser ? currentUser.email : bookingData.clientEmail,
          phone: currentUser ? (currentUser.phone || bookingData.clientPhone) : bookingData.clientPhone,
        },
        serviceId: bookingData.serviceId,
        professionalId: bookingData.professionalId,
        scheduledDate: bookingData.date,
        scheduledTime: bookingData.time,
        notes: '',
      };
      
      console.log('Booking data:', appointmentData);
      
      // Call the API to create the appointment
      await apiClient.createAppointment(appointmentData);
      
      toast({
        title: 'Cita reservada!',
        description: 'Tu cita ha sido reservada exitosamente.',
      });
      
      // Reset form
      setBookingData({
        clientName: currentUser ? `${currentUser.firstName} ${currentUser.lastName}` : '',
        clientEmail: currentUser ? currentUser.email : '',
        clientPhone: currentUser ? (currentUser.phone || '') : '',
        serviceId: '',
        professionalId: '',
        date: '',
        time: '',
      });
      
      // Set default date to tomorrow again
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      setBookingData(prev => ({
        ...prev,
        date: tomorrow.toISOString().split('T')[0],
      }));
    } catch (error) {
      console.error('Error booking appointment:', error);
      toast({
        title: 'Error',
        description: 'No se pudo reservar la cita. Por favor, intenta nuevamente.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return '';
    
    const date = new Date(dateString);
    const options: Intl.DateTimeFormatOptions = { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    };
    
    return date.toLocaleDateString('es-ES', options);
  };

  // Filter professionals based on selected service
  // Professionals have a 'services' relation that contains the services they can perform
  const filteredProfessionals = bookingData.serviceId 
    ? professionals.filter(pro => 
        pro.services?.some(ps => ps.serviceId === bookingData.serviceId)
      )
    : professionals;

  // Filter available dates based on salon settings
  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedDate = new Date(e.target.value);
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Reset time to start of day for comparison
    
    // Check if date is in the past
    if (selectedDate < today) {
      toast({
        title: 'Fecha no disponible',
        description: 'No puedes seleccionar una fecha pasada',
        variant: 'destructive',
      });
      setAvailableSlots([]);
      return;
    }
    
    const dayOfWeek = selectedDate.getDay();
    
    // Salon is open Monday-Saturday (1-6)
    if (dayOfWeek === 0) { // Sunday
      toast({
        title: 'Día no disponible',
        description: 'El salón está cerrado los domingos',
        variant: 'destructive',
      });
      setAvailableSlots([]);
      return;
    }
    
    // Clear time slots and selected time when date changes
    setAvailableSlots([]);
    setBookingData(prev => ({
      ...prev,
      date: e.target.value,
      time: '',
    }));
  };

  if (loading && !salonData) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="animate-spin w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full"></div>
        <span className="ml-4 text-gray-600">Cargando información...</span>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-lg p-8">
      <h2 className="text-2xl font-bold text-purple-900 mb-6 text-center">
        Reserva tu cita
      </h2>
      
      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Step 1: Client Information */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center">
            <User className="w-5 h-5 mr-2 text-purple-600" />
            Información del cliente
          </h3>
          
          {currentUser ? (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <p className="text-green-800 mb-2">
                <strong>Información prellenada desde tu cuenta</strong>
              </p>
              <p className="text-sm text-green-700 mb-1">
                <strong>Nombre:</strong> {currentUser.firstName} {currentUser.lastName}
              </p>
              <p className="text-sm text-green-700 mb-1">
                <strong>Email:</strong> {currentUser.email}
              </p>
              {currentUser.phone && (
                <p className="text-sm text-green-700">
                  <strong>Teléfono:</strong> {currentUser.phone}
                </p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label htmlFor="clientName" className="block text-sm font-medium text-gray-700 mb-1">
                  Nombre completo *
                </label>
                <input
                  type="text"
                  id="clientName"
                  name="clientName"
                  value={bookingData.clientName}
                  onChange={handleInputChange}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                  placeholder="John Doe"
                />
              </div>
              <div>
                <label htmlFor="clientEmail" className="block text-sm font-medium text-gray-700 mb-1">
                  Email *
                </label>
                <input
                  type="email"
                  id="clientEmail"
                  name="clientEmail"
                  value={bookingData.clientEmail}
                  onChange={handleInputChange}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                  placeholder="john@example.com"
                />
              </div>
              <div>
                <label htmlFor="clientPhone" className="block text-sm font-medium text-gray-700 mb-1">
                  Teléfono
                </label>
                <input
                  type="tel"
                  id="clientPhone"
                  name="clientPhone"
                  value={bookingData.clientPhone}
                  onChange={handleInputChange}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                  placeholder="+34 123 456 789"
                />
              </div>
            </div>
          )}
        </div>

        {/* Step 2: Service Selection */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center">
            <Scissors className="w-5 h-5 mr-2 text-purple-600" />
            Selecciona un servicio
          </h3>
          <select
            id="serviceId"
            name="serviceId"
            value={bookingData.serviceId}
            onChange={handleInputChange}
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
          >
            <option value="">-- Selecciona un servicio --</option>
            {services.map(service => (
              <option key={service.id} value={service.id}>
                {service.name} - {service.price}€ ({service.duration} min)
              </option>
            ))}
          </select>
        </div>

        {/* Step 3: Professional Selection */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center">
            <User className="w-5 h-5 mr-2 text-purple-600" />
            Selecciona un profesional
          </h3>
          {filteredProfessionals.length === 0 ? (
            <p className="text-gray-500 text-center py-4">
              {bookingData.serviceId 
                ? 'No hay profesionales disponibles para este servicio'
                : 'Selecciona un servicio primero para ver los profesionales disponibles'}
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {filteredProfessionals.map(pro => (
                <button
                  key={pro.id}
                  type="button"
                  onClick={() => {
                    setAvailableSlots([]);
                    setBookingData(prev => ({
                      ...prev,
                      professionalId: pro.id,
                      time: '',
                    }));
                  }}
                  className={`flex flex-col items-center p-4 rounded-xl border-2 transition-all ${
                    bookingData.professionalId === pro.id
                      ? 'border-purple-600 bg-purple-50 shadow-md'
                      : 'border-gray-200 hover:border-purple-300 hover:bg-gray-50'
                  }`}
                >
                  <div className="w-20 h-20 rounded-full overflow-hidden mb-3 bg-gray-200">
                    {pro.profileImage ? (
                      <img
                        src={pro.profileImage}
                        alt={`${pro.firstName} ${pro.lastName}`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-purple-100 text-purple-600">
                        <User className="w-10 h-10" />
                      </div>
                    )}
                  </div>
                  <span className={`text-sm font-medium text-center ${
                    bookingData.professionalId === pro.id
                      ? 'text-purple-700'
                      : 'text-gray-700'
                  }`}>
                    {pro.firstName} {pro.lastName}
                  </span>
                </button>
              ))}
            </div>
          )}
          {/* Hidden input for form validation */}
          <input
            type="hidden"
            name="professionalId"
            value={bookingData.professionalId}
            required
          />
        </div>

        {/* Step 4: Date Selection */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center">
            <Calendar className="w-5 h-5 mr-2 text-purple-600" />
            Selecciona una fecha
          </h3>
          <input
            type="date"
            id="date"
            name="date"
            value={bookingData.date}
            onChange={handleDateChange}
            min={new Date().toISOString().split('T')[0]}
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
          />
        </div>

        {/* Step 5: Time Selection */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 flex items-center">
            <Clock className="w-5 h-5 mr-2 text-purple-600" />
            Selecciona un horario
          </h3>
          <div className="grid grid-cols-4 gap-2">
            {availableSlots.map(slot => (
              <button
                key={slot.time}
                type="button"
                disabled={!slot.available}
                onClick={() => setBookingData(prev => ({ ...prev, time: slot.time }))}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  bookingData.time === slot.time
                    ? 'bg-purple-600 text-white'
                    : slot.available
                    ? 'bg-white border border-gray-300 hover:bg-gray-50'
                    : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                }`}
              >
                {slot.time}
              </button>
            ))}
          </div>
        </div>

        {/* Step 6: Submit */}
        <div className="text-center">
          <button
            type="submit"
            disabled={loading || !bookingData.time}
            className="inline-flex items-center space-x-2 px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
          >
            {loading ? (
              <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full"></div>
            ) : null}
            <span>{loading ? 'Reservando...' : 'Reservar Cita'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
