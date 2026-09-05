"use client";

import BookingWidget from '@/components/booking/BookingWidget';

// Mock data for demonstration
const mockSalon = {
  id: 'salon-1',
  name: 'Kira Room',
  description: 'Beauty and wellness salon',
  address: '123 Main St, Madrid',
  phone: '+34 600 000 000',
  email: 'info@kira-room.com',
  isActive: true,
};

const mockServices = [
  {
    id: 'service-1',
    name: 'Corte de Cabello',
    description: 'Corte profesional de cabello',
    duration: 60,
    price: 35,
    currency: 'EUR',
    category: 'hair',
    isActive: true,
  },
  {
    id: 'service-2',
    name: 'Manicura',
    description: 'Manicura completa',
    duration: 45,
    price: 25,
    currency: 'EUR',
    category: 'nails',
    isActive: true,
  },
  {
    id: 'service-3',
    name: 'Facial',
    description: 'Tratamiento facial',
    duration: 90,
    price: 65,
    currency: 'EUR',
    category: 'facial',
    isActive: true,
  },
];

const mockProfessionals = [
  {
    id: 'professional-1',
    firstName: 'María',
    lastName: 'García',
    email: 'maria@kira-room.com',
    specialties: ['cortes', 'color'],
    isActive: true,
  },
  {
    id: 'professional-2',
    firstName: 'Ana',
    lastName: 'López',
    email: 'ana@kira-room.com',
    specialties: ['manicura', 'pedicura'],
    isActive: true,
  },
  {
    id: 'professional-3',
    firstName: 'Carmen',
    lastName: 'Rodríguez',
    email: 'carmen@kira-room.com',
    specialties: ['facial', 'masajes'],
    isActive: true,
  },
];

export default function ExampleBookingPage() {
  const handleBookingComplete = (appointment: any) => {
    console.log('Booking completed:', appointment);
    alert(`¡Reserva confirmada! ID: ${appointment.id}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-pink-50 via-purple-50 to-indigo-100 py-12">
      <div className="container mx-auto px-4">
        {/* Header Section */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-r from-pink-500 to-purple-600 rounded-full mb-6 shadow-lg">
            <span className="text-2xl">💄</span>
          </div>
          <h1 className="text-4xl font-bold bg-gradient-to-r from-pink-600 to-purple-600 bg-clip-text text-transparent mb-4">
            Reserva en Kira Room
          </h1>
          <p className="text-lg text-gray-700 max-w-2xl mx-auto">
            Experimenta la elegancia y comodidad de nuestro sistema de reservas online
          </p>
          <div className="mt-6 inline-flex items-center px-4 py-2 bg-white/80 backdrop-blur-sm text-purple-700 rounded-full text-sm font-medium shadow-md border border-purple-200">
            <span className="mr-2">✨</span>
            Integración completa con API de disponibilidad en tiempo real
          </div>
        </div>

        {/* Booking Widget */}
        <div className="flex justify-center mb-12">
          <div className="bg-white/90 backdrop-blur-sm rounded-2xl shadow-2xl border border-white/20 p-8 max-w-4xl w-full">
            <BookingWidget
              salon={mockSalon}
              services={mockServices}
              professionals={mockProfessionals}
              onBookingComplete={handleBookingComplete}
              language="es"
            />
          </div>
        </div>

        {/* Instructions Section */}
        <div className="max-w-2xl mx-auto">
          <div className="bg-white/90 backdrop-blur-sm p-6 rounded-2xl shadow-xl border border-white/20">
            <div className="flex items-center mb-4">
              <div className="w-8 h-8 bg-gradient-to-r from-pink-500 to-purple-600 rounded-full flex items-center justify-center mr-3">
                <span className="text-white text-sm font-bold">?</span>
              </div>
              <h3 className="text-xl font-semibold text-gray-800">Cómo hacer tu reserva</h3>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-3">
                <div className="flex items-start">
                  <div className="w-6 h-6 bg-pink-100 text-pink-600 rounded-full flex items-center justify-center text-xs font-bold mr-3 mt-0.5">1</div>
                  <span className="text-gray-700">Selecciona tu servicio preferido</span>
                </div>
                <div className="flex items-start">
                  <div className="w-6 h-6 bg-purple-100 text-purple-600 rounded-full flex items-center justify-center text-xs font-bold mr-3 mt-0.5">2</div>
                  <span className="text-gray-700">Elige a tu profesional</span>
                </div>
                <div className="flex items-start">
                  <div className="w-6 h-6 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center text-xs font-bold mr-3 mt-0.5">3</div>
                  <span className="text-gray-700">Selecciona fecha y hora disponible</span>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-start">
                  <div className="w-6 h-6 bg-pink-100 text-pink-600 rounded-full flex items-center justify-center text-xs font-bold mr-3 mt-0.5">4</div>
                  <span className="text-gray-700">Completa tus datos personales</span>
                </div>
                <div className="flex items-start">
                  <div className="w-6 h-6 bg-purple-100 text-purple-600 rounded-full flex items-center justify-center text-xs font-bold mr-3 mt-0.5">5</div>
                  <span className="text-gray-700">Confirma tu reserva</span>
                </div>
              </div>
            </div>
            <div className="mt-6 p-4 bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg border border-blue-200">
              <p className="text-sm text-gray-600 text-center">
                <span className="font-medium">💡 Nota:</span> Este ejemplo utiliza datos de demostración para servicios y profesionales,
                pero la disponibilidad de horarios se obtiene directamente de nuestro backend en tiempo real.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
