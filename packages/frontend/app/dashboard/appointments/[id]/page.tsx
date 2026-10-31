'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Calendar,
  Clock,
  User,
  Scissors,
  Phone,
  Mail,
  ChevronLeft,
  CheckCircle,
  XCircle,
  Edit,
  Trash2,
  UserX,
} from 'lucide-react';
import apiClient from '../../../../lib/api';
import {
  appointmentEditHref,
  asksFirst,
  calculateTotalDuration,
  formatDateString,
  formatDateTimeString,
  formatEuros,
  mergeActivity,
  sendStatusChange,
  serverMessage,
  statusActions,
  toDrawerAppointment,
  type AskedStatus,
} from '../components/appointment-drawer.utils';
import { StatusChangeDialog } from '../components/StatusChangeDialog';
import { AppointmentStatusBadge } from '../components/appointment-drawer/primitives/AppointmentStatusBadge';
import { PaymentSummaryCard } from '../components/appointment-drawer/cards/PaymentSummaryCard';
import { SalonTermsCard } from '../components/appointment-drawer/cards/SalonTermsCard';
import { ActivitySection } from '../components/appointment-drawer/sections/ActivitySection';
import type { Appointment, AppointmentStatus } from '../components/appointment-drawer/types';
import { useTranslations } from '@/lib/use-translation';
import { getCurrentUser } from '../../../../lib/utils';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/use-toast';

/**
 * One appointment, read-only: the same data, wording and formats as the
 * agenda's drawer (it reuses the drawer's cards), in Spanish, with euros.
 * "Editar" opens it in the drawer.
 */
export default function AppointmentDetailPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [updating, setUpdating] = useState(false);
  const [appointment, setAppointment] = useState<Appointment | null>(null);
  const [loading, setLoading] = useState(true);
  // null: loaded; a string: the server's reason ("" when it gave none).
  const [error, setError] = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  // Deleting an appointment is for the owner and managers; a professional
  // cancels instead. Read after mount: localStorage is not there on the server.
  const [role, setRole] = useState<string | undefined>(undefined);
  const canDelete = !!role && role !== 'staff';
  const manager = role === 'owner' || role === 'admin';
  // Asked in the panel's dialog, not window.confirm.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { toast } = useToast();
  const t = useTranslations();
  // Cancelling and a no-show tell the client, and completing is final and
  // may issue an invoice, so they are asked first.
  const [askingStatus, setAskingStatus] = useState<AskedStatus | null>(null);
  useEffect(() => {
    setRole(getCurrentUser()?.role);
  }, []);

  useEffect(() => {
    let current = true;
    const fetchAppointment = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await apiClient.getAppointment(params.id);
        if (current) setAppointment(toDrawerAppointment(data));
      } catch (err) {
        console.error('Error fetching appointment:', err);
        if (current) setError(serverMessage(err) ?? '');
      } finally {
        if (current) setLoading(false);
      }
    };

    if (params.id) {
      fetchAppointment();
    }
    return () => {
      current = false;
    };
  }, [params.id]);

  const loadActivity = async () => {
    if (!appointment) return;
    setActivityLoading(true);
    try {
      const entries = (await apiClient.getAppointmentActivity(appointment.id)) as any[];
      setAppointment((prev) =>
        prev ? { ...prev, activity: mergeActivity(prev.createdAt, entries) } : prev,
      );
    } catch (err) {
      console.error('Error fetching activity:', err);
    } finally {
      setActivityLoading(false);
    }
  };

  const requestStatusChange = (newStatus: AppointmentStatus) => {
    if (asksFirst(newStatus)) {
      setAskingStatus(newStatus);
    } else {
      void handleStatusChange(newStatus);
    }
  };

  const handleStatusChange = async (newStatus: AppointmentStatus, reason?: string) => {
    setUpdating(true);
    try {
      // Cancel, complete and no-show go to their own routes, which send the
      // notices, tell the wait-list and issue the invoice.
      await sendStatusChange(apiClient, params.id, newStatus, reason);
      setAppointment((prev) => (prev ? { ...prev, status: newStatus } : prev));
    } catch (error) {
      console.error('Error updating appointment status:', error);
      toast({
        title: t('appointments.statusChangeFailed'),
        description: serverMessage(error),
        variant: 'destructive',
      });
    } finally {
      setUpdating(false);
      setAskingStatus(null);
    }
  };

  const statusButtons: Partial<Record<AppointmentStatus, { icon: React.ReactNode; className: string; label: string }>> = {
    confirmed: { icon: <CheckCircle className="w-4 h-4 mr-1" />, className: 'bg-green-600 hover:bg-green-700', label: t('appointments.confirm') },
    in_progress: { icon: <Clock className="w-4 h-4 mr-1" />, className: 'bg-blue-600 hover:bg-blue-700', label: t('appointments.start') },
    completed: { icon: <CheckCircle className="w-4 h-4 mr-1" />, className: 'bg-green-600 hover:bg-green-700', label: t('appointments.complete') },
    no_show: { icon: <UserX className="w-4 h-4 mr-1" />, className: 'bg-gray-600 hover:bg-gray-700', label: t('appointments.no_show') },
    cancelled: { icon: <XCircle className="w-4 h-4 mr-1" />, className: 'bg-red-600 hover:bg-red-700', label: t('appointments.cancel') },
  };

  const handleEdit = () => {
    // Appointments are edited in the agenda's drawer; there is no /edit page.
    router.push(appointmentEditHref(params.id));
  };

  const performDelete = async () => {
    setUpdating(true);
    try {
      await apiClient.deleteAppointment(params.id);
      router.push('/dashboard/appointments');
    } catch (error) {
      // Stay on the page: navigating away would read as "deleted".
      console.error('Error deleting appointment:', error);
      setConfirmDelete(false);
      // The server says why: a completed, paid or invoiced appointment is
      // history and is cancelled, not deleted.
      toast({
        title: t('appointments.detail.deleteFailed'),
        description: serverMessage(error),
        variant: 'destructive',
      });
    } finally {
      setUpdating(false);
    }
  };

  const backButton = (
    <button
      type="button"
      onClick={() => router.back()}
      className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
    >
      {t('appointments.detail.back')}
    </button>
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
          <span className="ml-3">{t('appointments.drawer.loadingDetails')}</span>
        </div>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="text-red-500 text-lg font-semibold mb-2">{t('appointments.detail.loadFailed')}</div>
            {error && <p className="text-gray-600">{error}</p>}
            {backButton}
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
            <div className="text-gray-500 text-lg font-semibold mb-2">{t('appointments.drawer.notFound')}</div>
            {backButton}
          </div>
        </div>
      </div>
    );
  }

  const rows = appointment.services ?? [];
  const isMulti = rows.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center space-x-4 min-w-0">
          <button
            type="button"
            onClick={() => router.back()}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label={t('appointments.detail.back')}
            title={t('appointments.detail.back')}
          >
            <ChevronLeft className="w-5 h-5 text-gray-600" />
          </button>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 truncate">{t('appointments.appointment_details')}</h1>
            <p className="text-gray-500 mt-1">{t('appointments.view_manage_appointment')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleEdit}
            className="inline-flex items-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Edit className="w-4 h-4 mr-2" />
            {t('appointments.edit')}
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={updating}
              className="inline-flex items-center px-4 py-2 border border-red-300 text-red-700 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              {t('appointments.detail.delete')}
            </button>
          )}
        </div>
      </div>

      {/* Status and Actions Bar */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <AppointmentStatusBadge status={appointment.status} />
            <div className="text-sm text-gray-500">
              {t('appointments.created')} {formatDateTimeString(appointment.createdAt)}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {updating ? (
              <span className="inline-flex items-center px-3 py-1.5 bg-gray-100 text-gray-600 text-sm rounded-lg">
                <div className="animate-spin w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full mr-2"></div>
                {t('appointments.updating')}
              </span>
            ) : (
              statusActions(appointment.status).map((to) => {
                const button = statusButtons[to as AppointmentStatus];
                if (!button) return null;
                return (
                  <button
                    key={to}
                    type="button"
                    onClick={() => requestStatusChange(to as AppointmentStatus)}
                    className={`inline-flex items-center px-3 py-1.5 ${button.className} text-white text-sm rounded-lg transition-colors`}
                  >
                    {button.icon}
                    {button.label}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left Column - Appointment Info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Date & Time Card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('appointments.schedule')}</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex items-start space-x-3">
                <div className="p-2 bg-indigo-50 rounded-lg">
                  <Calendar className="w-5 h-5 text-indigo-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">{t('appointments.date')}</p>
                  <p className="font-medium text-gray-900 first-letter:uppercase">{formatDateString(appointment.date)}</p>
                </div>
              </div>
              <div className="flex items-start space-x-3">
                <div className="p-2 bg-indigo-50 rounded-lg">
                  <Clock className="w-5 h-5 text-indigo-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">{t('appointments.time')}</p>
                  <p className="font-medium text-gray-900">{appointment.time}</p>
                  <p className="text-sm text-gray-500">{calculateTotalDuration(appointment)} min</p>
                </div>
              </div>
            </div>
          </div>

          {/* Services Card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('appointments.services')}</h2>
            <div className="space-y-4">
              {(isMulti
                ? rows.map((row) => ({
                    key: row.id,
                    service: row.service,
                    isParallel: row.isParallel,
                    professional: row.professional
                      ? `${row.professional.firstName} ${row.professional.lastName}`
                      : '',
                  }))
                : [{ key: appointment.service.id, service: appointment.service, isParallel: false, professional: '' }]
              ).map((item) => (
                <div key={item.key} className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <div className="p-3 bg-purple-50 rounded-lg self-start">
                    <Scissors className="w-6 h-6 text-purple-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-gray-900">{item.service?.name || t('appointments.service')}</h3>
                    {item.service?.description && (
                      <p className="text-sm text-gray-500 mt-1">{item.service.description}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-4 mt-3">
                      <span className="text-sm text-gray-600">
                        <Clock className="w-4 h-4 inline mr-1" />
                        {item.service?.duration || 0} min
                      </span>
                      <span className="text-sm font-medium text-gray-900">{formatEuros(item.service?.price)}</span>
                      {item.isParallel && (
                        <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">
                          {t('appointments.parallel')}
                        </span>
                      )}
                      {item.professional && (
                        <span className="text-sm text-gray-600">
                          <User className="w-4 h-4 inline mr-1" />
                          {item.professional}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {appointment.addons.length > 0 && (
                <div className="border-t border-gray-100 pt-3">
                  <h3 className="text-sm font-medium text-gray-900 mb-2">{t('appointments.add_ons')}</h3>
                  {appointment.addons.map((addon) => (
                    <div key={addon.id} className="flex items-center justify-between text-sm text-gray-600">
                      <span>
                        {addon.name} × {addon.quantity}
                      </span>
                      <span>{formatEuros(addon.price)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Client Card */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">{t('appointments.client')}</h2>
              <a
                href={`/dashboard/clients/${appointment.client.id}`}
                className="text-sm text-indigo-600 hover:text-indigo-700"
              >
                {t('appointments.view_profile')}
              </a>
            </div>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div className="w-12 h-12 bg-indigo-100 rounded-full flex items-center justify-center">
                <User className="w-6 h-6 text-indigo-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-gray-900">{appointment.client.name}</h3>
                <div className="mt-2 space-y-2">
                  {appointment.client.email && (
                    <a
                      href={`mailto:${appointment.client.email}`}
                      className="flex items-center text-sm text-gray-600 hover:text-indigo-600 break-all"
                    >
                      <Mail className="w-4 h-4 mr-2 text-gray-400 flex-shrink-0" />
                      {appointment.client.email}
                    </a>
                  )}
                  {appointment.client.phone && (
                    <a
                      href={`tel:${appointment.client.phone}`}
                      className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                    >
                      <Phone className="w-4 h-4 mr-2 text-gray-400 flex-shrink-0" />
                      {appointment.client.phone}
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Professional Card: one service (a visit shows them per service) */}
          {!isMulti && (
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">{t('appointments.professional')}</h2>
                <a
                  href={`/dashboard/professionals/${appointment.professional.id}`}
                  className="text-sm text-indigo-600 hover:text-indigo-700"
                >
                  {t('appointments.view_profile')}
                </a>
              </div>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                  <User className="w-6 h-6 text-green-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900">{appointment.professional.name}</h3>
                  {appointment.professional.specialty && (
                    <span className="inline-block px-2 py-0.5 bg-gray-100 text-gray-700 text-xs rounded-full mt-1">
                      {appointment.professional.specialty}
                    </span>
                  )}
                  <div className="mt-2 space-y-2">
                    {appointment.professional.email && (
                      <a
                        href={`mailto:${appointment.professional.email}`}
                        className="flex items-center text-sm text-gray-600 hover:text-indigo-600 break-all"
                      >
                        <Mail className="w-4 h-4 mr-2 text-gray-400 flex-shrink-0" />
                        {appointment.professional.email}
                      </a>
                    )}
                    {appointment.professional.phone && (
                      <a
                        href={`tel:${appointment.professional.phone}`}
                        className="flex items-center text-sm text-gray-600 hover:text-indigo-600"
                      >
                        <Phone className="w-4 h-4 mr-2 text-gray-400 flex-shrink-0" />
                        {appointment.professional.phone}
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Column - Sidebar */}
        <div className="space-y-6">
          <PaymentSummaryCard appointment={appointment} editMode={false} currentAddons={appointment.addons} />

          {/* Notes */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('appointments.notes')}</h2>
            {appointment.notes ? (
              <p className="text-sm text-gray-600 whitespace-pre-line">{appointment.notes}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">{t('appointments.no_notes_for_appointment')}</p>
            )}
          </div>

          {manager && (
            <SalonTermsCard appointment={appointment} editMode={false} form={null} onChange={() => {}} />
          )}

          <ActivitySection appointment={appointment} activityLoading={activityLoading} onToggle={loadActivity} />
        </div>
      </div>

      <StatusChangeDialog
        to={askingStatus}
        loading={updating}
        onCancel={() => setAskingStatus(null)}
        onConfirm={(reason) => {
          if (askingStatus) void handleStatusChange(askingStatus, reason);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={t('appointments.detail.deleteConfirmTitle')}
        description={t('appointments.detail.deleteConfirmDescription')}
        confirmLabel={t('appointments.detail.deleteConfirm')}
        destructive
        loading={updating}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={performDelete}
      />
    </div>
  );
}
