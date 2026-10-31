'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Calendar, Clock, Scissors, User, ChevronRight } from 'lucide-react';
import apiClient from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';
import { formatPrice, type PublicSalonPage } from '@/lib/salon-seo';
import {
  bookingDateFromQuery,
  bookingErrorMessage,
  isClosedDay,
  isOfferedTime,
  localDateString,
  localTomorrow,
  privacyPolicyUrl,
  slotsState,
  type SlotsState,
} from '@/lib/public-booking';

/** What the time picker says when it has no time to offer. */
const SLOTS_MESSAGE: Record<Exclude<SlotsState, 'ready'>, string> = {
  select_service_first: 'Selecciona primero un servicio',
  select_professional_first: 'Elige un profesional para ver las horas libres',
  loading_slots: 'Buscando horas libres…',
  closed_day: 'El salón no abre este día. Elige otra fecha.',
  no_slots: 'No quedan horas libres este día. Prueba con otra fecha u otro profesional.',
};

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
  currency: string;
  openingHours: PublicSalonPage['openingHours'];
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
  const [slotsLoading, setSlotsLoading] = useState(false);
  // Bumped to ask the server for the slots again (after a failed booking).
  const [slotsRefresh, setSlotsRefresh] = useState(0);
  // The client's own calendar day, set after mount (the server renders in UTC).
  const [today, setToday] = useState('');
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
  
  // Pre-fill service, professional and day from URL params. "Repetir" sends
  // serviceId and professionalId; the rebooking reminder email sends
  // ?service=; a wait-list style link may carry ?date=.
  useEffect(() => {
    const serviceId = searchParams?.get('serviceId') || searchParams?.get('service');
    const professionalId = searchParams?.get('professionalId');
    const date = bookingDateFromQuery(searchParams?.get('date'));
    if (serviceId || professionalId || date) {
      setBookingData(prev => ({
        ...prev,
        serviceId: serviceId || prev.serviceId,
        professionalId: professionalId || prev.professionalId,
        date: date || prev.date,
        time: '',
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

  // Default date: tomorrow in the client's calendar (toISOString() gave the
  // UTC day, still today after midnight in Spain). A date from the link wins.
  useEffect(() => {
    setToday(localDateString());
    setBookingData(prev => ({
      ...prev,
      date: prev.date || localTomorrow(),
    }));
  }, []);

  // Fetch salon data, professionals, and services
  useEffect(() => {
    const fetchSalonData = async () => {
      try {
        setLoading(true);
        
        // The salon is the one in the URL. This page used to take the
        // tenant from whichever professional the API listed first -- and
        // that list was every salon's -- then filled in an invented name,
        // address, phone and email.
        // The page's data rather than the bare tenant: it carries the
        // salon's currency and opening hours too.
        const tenant = await apiClient.getPublicSalonPage(params.salonName);
        setSalonData({
          id: tenant.id,
          name: tenant.name,
          currency: tenant.currency || 'EUR',
          openingHours: tenant.openingHours ?? {},
        });

        const [professionalsData, servicesData] = await Promise.all([
          apiClient.getProfessionalsPublic(tenant.id),
          apiClient.getServices(tenant.id),
        ]);
        setProfessionals(professionalsData as any);
        // Only what the salon takes online: the server refuses the rest.
        setServices((servicesData as any[]).filter((s) => s.isActive !== false && s.isOnlineBookable !== false) as any);
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
    // The list on screen belongs to the previous inputs: drop it, so nothing
    // from it can be picked or sent while the new one loads.
    setAvailableSlots([]);
    let cancelled = false;
    const wanted = !!(salonData && bookingData.professionalId && bookingData.serviceId && bookingData.date);
    setSlotsLoading(wanted);

    const fetchAvailableSlots = async () => {
      // Only fetch slots if service and professional are selected
      if (!wanted || !salonData) return;

      try {
        // The server's slots: on the professional's shift, inside opening
        // hours, not overlapping. This page used to offer every half hour
        // from 09:00 to 19:30 to anyone, the way the public page once did.
        const slots = await apiClient.getAvailableSlots(
          salonData.id,
          bookingData.professionalId,
          bookingData.serviceId,
          bookingData.date,
        );
        if (cancelled) return;
        const offered = slots.map((slot) => ({ time: slot.time, available: slot.isAvailable }));
        setAvailableSlots(offered);
        // A time picked earlier stays only while this list still offers it.
        setBookingData(prev =>
          prev.time && !isOfferedTime(prev.time, offered) ? { ...prev, time: '' } : prev,
        );
      } catch (error) {
        if (cancelled) return;
        console.error('Error fetching available slots:', error);
        toast({
          title: 'Error',
          description: 'No se pudieron cargar los horarios disponibles',
          variant: 'destructive',
        });
      } finally {
        if (!cancelled) setSlotsLoading(false);
      }
    };

    // Debounce fetching slots
    const timer = setTimeout(() => {
      fetchAvailableSlots();
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [salonData, bookingData.professionalId, bookingData.serviceId, bookingData.date, slotsRefresh]);

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
    // Only a time the server offered for the inputs on screen.
    if (!isOfferedTime(bookingData.time, availableSlots)) {
      setBookingData(prev => ({ ...prev, time: '' }));
      toast({
        title: 'Selecciona una hora',
        description: 'Esa hora ya no está libre. Elige otra.',
        variant: 'destructive',
      });
      return;
    }
    setLoading(true);

    try {
      // Get the selected service to get duration and price
      const selectedService = services.find(s => s.id === bookingData.serviceId);
      
      const appointmentData = {
        // Always send clientInfo - the backend will find or create the client
        clientInfo: {
          firstName: currentUser ? currentUser.firstName : bookingData.clientName.split(' ')[0],
          lastName: currentUser ? currentUser.lastName : bookingData.clientName.split(' ').slice(1).join(' '),
          email: (currentUser ? currentUser.email : bookingData.clientEmail.trim()) || undefined,
          phone: currentUser ? (currentUser.phone || bookingData.clientPhone) : bookingData.clientPhone,
        },
        serviceId: bookingData.serviceId,
        professionalId: bookingData.professionalId,
        scheduledDate: bookingData.date,
        scheduledTime: bookingData.time,
        notes: '',
      };
      
      // Call the API to create the appointment
      await apiClient.createAppointment(appointmentData);
      
      toast({
        title: 'Cita reservada!',
        description: 'Tu cita ha sido reservada exitosamente.',
      });
      
      // Reset form, with tomorrow as the date again
      setBookingData({
        clientName: currentUser ? `${currentUser.firstName} ${currentUser.lastName}` : '',
        clientEmail: currentUser ? currentUser.email : '',
        clientPhone: currentUser ? (currentUser.phone || '') : '',
        serviceId: '',
        professionalId: '',
        date: localTomorrow(),
        time: '',
      });
    } catch (error) {
      console.error('Error booking appointment:', error);
      // The server's reason when it gives one (the slot was taken, the
      // phone is not valid...): "try again" alone does not say whether
      // trying again would help.
      toast({
        title: 'Error',
        description:
          (error instanceof Error && bookingErrorMessage(error.message)) ||
          'No se pudo reservar la cita. Por favor, inténtalo de nuevo.',
        variant: 'destructive',
      });
      // Ask for the slots again: the one picked may be gone.
      setSlotsRefresh(n => n + 1);
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

  // This refused every Sunday for every salon, whatever its hours, and read
  // the weekday from a UTC date (west of Greenwich, Mondays). The server's
  // slots say what is free; the salon's recorded hours only choose the
  // message when nothing is (see isClosedDay).
  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    // Both YYYY-MM-DD, local calendar: the string order is the date order.
    if (value && value < localDateString()) {
      toast({
        title: 'Fecha no disponible',
        description: 'No puedes seleccionar una fecha pasada',
        variant: 'destructive',
      });
      return;
    }

    // Clear time slots and selected time when date changes
    setAvailableSlots([]);
    setBookingData(prev => ({
      ...prev,
      date: value,
      time: '',
    }));
  };

  const slotsView = slotsState({
    serviceId: bookingData.serviceId,
    professionalId: bookingData.professionalId,
    date: bookingData.date,
    loading: slotsLoading,
    slots: availableSlots,
    closed: isClosedDay(bookingData.date, salonData?.openingHours),
  });

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
              {currentUser.phone ? (
                <p className="text-sm text-green-700">
                  <strong>Teléfono:</strong> {currentUser.phone}
                </p>
              ) : (
                // Online bookings need a phone: it is how the salon reaches
                // the client about a last-minute change.
                <div className="mt-3">
                  <label htmlFor="clientPhone" className="block text-sm font-medium text-gray-700 mb-1">
                    Teléfono *
                  </label>
                  <input
                    type="tel"
                    id="clientPhone"
                    name="clientPhone"
                    value={bookingData.clientPhone}
                    onChange={handleInputChange}
                    required
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                    placeholder="+34 600 123 456"
                  />
                </div>
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
                  placeholder="Nombre y apellidos"
                />
              </div>
              <div>
                <label htmlFor="clientEmail" className="block text-sm font-medium text-gray-700 mb-1">
                  Email (opcional)
                </label>
                <input
                  type="email"
                  id="clientEmail"
                  name="clientEmail"
                  value={bookingData.clientEmail}
                  onChange={handleInputChange}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                  placeholder="tu@email.com"
                />
              </div>
              <div>
                <label htmlFor="clientPhone" className="block text-sm font-medium text-gray-700 mb-1">
                  Teléfono *
                </label>
                <input
                  type="tel"
                  id="clientPhone"
                  name="clientPhone"
                  value={bookingData.clientPhone}
                  onChange={handleInputChange}
                  required
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                  placeholder="+34 600 123 456"
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
                {service.name} - {formatPrice(Number(service.price), salonData?.currency)} ({service.duration} min)
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
            min={today || undefined}
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
          {slotsView !== 'ready' ? (
            <p className="text-gray-500 text-center py-4" aria-live="polite">
              {SLOTS_MESSAGE[slotsView]}
            </p>
          ) : (
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
          )}
        </div>

        {/* Step 6: Submit */}
        <div className="text-center space-y-3">
          <button
            type="submit"
            disabled={loading || !isOfferedTime(bookingData.time, availableSlots)}
            className="inline-flex items-center space-x-2 px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
          >
            {loading ? (
              <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full"></div>
            ) : null}
            <span>{loading ? 'Reservando...' : 'Reservar Cita'}</span>
          </button>
          {/* Who uses the details on this form and what for (RGPD art. 13). */}
          <p className="text-xs text-gray-500">
            {salonData?.name || 'El salón'} usará tu nombre, teléfono y email solo para gestionar tu
            cita y enviarte avisos sobre ella (confirmación, recordatorios y cambios).{' '}
            <a
              href={privacyPolicyUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-purple-700"
            >
              Política de privacidad
            </a>
          </p>
        </div>
      </form>
    </div>
  );
}
