'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Calendar,
  Clock,
  User,
  Scissors,
  DollarSign,
  Phone,
  Mail,
  ChevronLeft,
  CheckCircle,
  XCircle,
  AlertCircle,
  Edit,
  Trash2
} from 'lucide-react';
import apiClient, { Appointment as ApiAppointment } from '../../../../lib/api';

type AppointmentStatus = 'confirmed' | 'pending' | 'in_progress' | 'completed' | 'cancelled';

interface PopulatedAppointment extends ApiAppointment {
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
}

interface Appointment {
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
  date: string;
  time: string;
  status: AppointmentStatus;
  price: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export default function AppointmentDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'details' | 'history' | 'notes'>('details');
  const [updating, setUpdating] = useState(false);
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchAppointment = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await apiClient.getAppointment(params.id) as PopulatedAppointment;

        // Transform API response to match our interface
        const transformedAppointment: Appointment = {
          id: data.id,
          client: {
            id: data.client.id,
            name: `${data.client.firstName} ${data.client.lastName}`,
            email: data.client.email || '',
            phone: data.client.phone || '',
          },
          professional: {
            id: data.professional.id,
            name: `${data.professional.firstName} ${data.professional.lastName}`,
            email: data.professional.email,
            phone: data.professional.phone || '',
            specialty: data.professional.specialties?.[0] || 'General',
          },
          service: {
            id: data.service.id,
            name: data.service.name,
            description: data.service.description || '',
            duration: data.service.duration,
            price: data.service.price,
          },
          date: data.scheduledDate.split('T')[0], // Extract date part
          time: data.scheduledTime,
          status: data.status as AppointmentStatus,
          price: data.price,
          notes: data.notes || '',
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        };

        setAppointment(transformedAppointment);
      } catch (err) {
        console.error('Error fetching appointment:', err);
        setError('Failed to load appointment details');
      } finally {
        setLoading(false);
      }
    };

    if (params.id) {
      fetchAppointment();
    }
  }, [params.id]);

  const getStatusBadge = (status: AppointmentStatus) => {
    const styles: Record<AppointmentStatus, { bg: string; text: string; border: string }> = {
      confirmed: { bg: 'bg-green-50', text: 'text-green-700', border: 'border-green-200' },
      pending: { bg: 'bg-yellow-50', text: 'text-yellow-700', border: 'border-yellow-200' },
      in_progress: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
      completed: { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
      cancelled: { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200' },
    };

    const statusLabels: Record<AppointmentStatus, string> = {
      confirmed: 'Confirmed',
      pending: 'Pending',
      in_progress: 'In Progress',
      completed: 'Completed',
      cancelled: 'Cancelled',
    };

    const icons: Record<AppointmentStatus, React.ReactNode> = {
      confirmed: <CheckCircle className="w-4 h-4 mr-2" />,
      pending: <AlertCircle className="w-4 h-4 mr-2" />,
      in_progress: <Clock className="w-4 h-4 mr-2" />,
      completed: <CheckCircle className="w-4 h-4 mr-2" />,
      cancelled: <XCircle className="w-4 h-4 mr-2" />,
    };

    const style = styles[status];

    return (
      <span className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border ${style.bg} ${style.text} ${style.border}`}>
        {icons[status]}
        {statusLabels[status]}
      </span>
    );
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
  };

  const formatDateTime = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleStatusChange = async (newStatus: AppointmentStatus) => {
    setUpdating(true);
    try {
      await apiClient.updateAppointment(params.id, { status: newStatus } as any);
      // Update local state
      if (appointment) {
        setAppointment({ ...appointment, status: newStatus });
      }
    } catch (error) {
      console.error('Error updating appointment status:', error);
      alert('Failed to update appointment status');
    } finally {
      setUpdating(false);
    }
  };

  const handleEdit = () => {
    router.push(`/dashboard/appointments/${params.id}/edit`);
  };

  const handleDelete = () => {
    // TODO: Implement delete confirmation and API call
    if (confirm('Are you sure you want to delete this appointment?')) {
      console.log('Deleting appointment:', params.id);
      router.push('/dashboard/appointments');
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
          <span className="ml-3">Loading appointment details...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="text-red-500 text-lg font-semibold mb-2">Error</div>
            <p className="text-gray-600">{error}</p>
            <button
              onClick={() => router.back()}
              className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              Go Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!appointment) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="text-gray-500 text-lg font-semibold mb-2">Appointment not found</div>
            <button
              onClick={() => router.back()}
              className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
            >
              Go Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
       <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
         <div className="flex items-center space-x-4">
          <button
            onClick={() => router.back()}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ChevronLeft className="w-5 h-5 text-gray-600" />
          </button>
          <div>
             <h1 className="text-2xl font-bold text-gray-900 truncate">Appointment Details</h1>
            <p className="text-gray-500 mt-1">View and manage appointment information</p>
          </div>
        </div>
         <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleEdit}
            className="inline-flex items-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Edit className="w-4 h-4 mr-2" />
            Edit
          </button>
          <button
            onClick={handleDelete}
            className="inline-flex items-center px-4 py-2 border border-red-300 text-red-700 rounded-lg hover:bg-red-50 transition-colors"
          >
            <Trash2 className="w-4 h-4 mr-2" />
            Delete
          </button>
        </div>
      </div>

      {/* Status and Actions Bar */}
       <div className="bg-white rounded-xl border border-gray-200 p-4">
         <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
           <div className="flex items-center space-x-4">
             {getStatusBadge(appointment.status)}
             <div className="text-sm text-gray-500">
               Created: {formatDateTime(appointment.createdAt)}
             </div>
           </div>
           <div className="flex flex-wrap items-center gap-3">
            {updating ? (
              <span className="inline-flex items-center px-3 py-1.5 bg-gray-100 text-gray-600 text-sm rounded-lg">
                <div className="animate-spin w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full mr-2"></div>
                Updating...
              </span>
            ) : (
              <>
                {appointment.status === 'pending' && (
                  <>
                    <button
                      onClick={() => handleStatusChange('confirmed')}
                      className="inline-flex items-center px-3 py-1.5 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition-colors"
                    >
                      <CheckCircle className="w-4 h-4 mr-1" />
                      Confirm
                    </button>
                    <button
                      onClick={() => handleStatusChange('cancelled')}
                      className="inline-flex items-center px-3 py-1.5 bg-red-600 text-white text-sm rounded-lg hover:bg-red-700 transition-colors"
                    >
                      <XCircle className="w-4 h-4 mr-1" />
                      Cancel
                    </button>
                  </>
                )}
                {appointment.status === 'confirmed' && (
                  <button
                    onClick={() => handleStatusChange('in_progress')}
                    className="inline-flex items-center px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    <Clock className="w-4 h-4 mr-1" />
                    Start
                  </button>
                )}
                {appointment.status === 'in_progress' && (
                  <button
                    onClick={() => handleStatusChange('completed')}
                    className="inline-flex items-center px-3 py-1.5 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition-colors"
                  >
                    <CheckCircle className="w-4 h-4 mr-1" />
                    Complete
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
       <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Left Column - Appointment Info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Date & Time Card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Schedule</h2>
             <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex items-start space-x-3">
                <div className="p-2 bg-indigo-50 rounded-lg">
                  <Calendar className="w-5 h-5 text-indigo-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Date</p>
                  <p className="font-medium text-gray-900">{formatDate(appointment.date)}</p>
                </div>
              </div>
              <div className="flex items-start space-x-3">
                <div className="p-2 bg-indigo-50 rounded-lg">
                  <Clock className="w-5 h-5 text-indigo-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Time</p>
                  <p className="font-medium text-gray-900">{appointment.time}</p>
                  <p className="text-sm text-gray-500">{appointment.service.duration} minutes</p>
                </div>
              </div>
            </div>
          </div>

          {/* Service Card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Service</h2>
             <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="p-3 bg-purple-50 rounded-lg">
                <Scissors className="w-6 h-6 text-purple-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900">{appointment.service.name}</h3>
                <p className="text-sm text-gray-500 mt-1">{appointment.service.description}</p>
             <div className="flex flex-wrap items-center gap-4 mt-3">
                  <span className="text-sm text-gray-600">
                    <Clock className="w-4 h-4 inline mr-1" />
                    {appointment.service.duration} min
                  </span>
                  <span className="text-sm font-medium text-gray-900">
                    <DollarSign className="w-4 h-4 inline" />
                    {appointment.service.price}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Client Card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
             <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Client</h2>
              <a
                href={`/dashboard/clients/${appointment.client.id}`}
                className="text-sm text-indigo-600 hover:text-indigo-700"
              >
                View Profile
              </a>
            </div>
             <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center">
                <User className="w-6 h-6 text-indigo-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900">{appointment.client.name}</h3>
                <div className="mt-2 space-y-2">
                  <a
                    href={`mailto:${appointment.client.email}`}
                    className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                  >
                    <Mail className="w-4 h-4 mr-2 text-gray-400" />
                    {appointment.client.email}
                  </a>
                  <a
                    href={`tel:${appointment.client.phone}`}
                    className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                  >
                    <Phone className="w-4 h-4 mr-2 text-gray-400" />
                    {appointment.client.phone}
                  </a>
                </div>
              </div>
            </div>
          </div>

          {/* Professional Card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
             <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Professional</h2>
              <a
                href={`/dashboard/professionals/${appointment.professional.id}`}
                className="text-sm text-indigo-600 hover:text-indigo-700"
              >
                View Profile
              </a>
            </div>
             <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                <User className="w-6 h-6 text-green-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900">{appointment.professional.name}</h3>
                <span className="inline-block px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded-full mt-1">
                  {appointment.professional.specialty}
                </span>
                <div className="mt-2 space-y-2">
                  <a
                    href={`mailto:${appointment.professional.email}`}
                    className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                  >
                    <Mail className="w-4 h-4 mr-2 text-gray-400" />
                    {appointment.professional.email}
                  </a>
                  <a
                    href={`tel:${appointment.professional.phone}`}
                    className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                  >
                    <Phone className="w-4 h-4 mr-2 text-gray-400" />
                    {appointment.professional.phone}
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column - Sidebar */}
        <div className="space-y-6">
          {/* Payment Summary */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Payment Summary</h2>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Service</span>
                <span className="font-medium text-gray-900">${appointment.service.price}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Duration</span>
                <span className="font-medium text-gray-900">{appointment.service.duration} min</span>
              </div>
              <div className="border-t border-gray-200 pt-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <span className="font-semibold text-gray-900">Total</span>
                  <span className="text-xl font-bold text-gray-900">${appointment.price}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Notes</h2>
            {appointment.notes ? (
              <p className="text-sm text-gray-600">{appointment.notes}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">No notes for this appointment</p>
            )}
          </div>

          {/* Activity Timeline */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Activity</h2>
            <div className="space-y-4">
              <div className="flex items-start space-x-3">
                <div className="w-2 h-2 bg-green-500 rounded-full mt-2" />
                <div>
                  <p className="text-sm font-medium text-gray-900">Appointment {appointment.status}</p>
                  <p className="text-xs text-gray-500">{formatDateTime(appointment.updatedAt)}</p>
                </div>
              </div>
              <div className="flex items-start space-x-3">
                <div className="w-2 h-2 bg-gray-300 rounded-full mt-2" />
                <div>
                  <p className="text-sm font-medium text-gray-900">Appointment created</p>
                  <p className="text-xs text-gray-500">{formatDateTime(appointment.createdAt)}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
