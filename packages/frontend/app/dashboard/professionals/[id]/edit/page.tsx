'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useState, useEffect, Suspense } from 'react';
import { ArrowLeft, Save, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import apiClient from '@/lib/api';
import { useTranslations } from '@/lib/use-translation';
import {
  currentSpecialty,
  specialtiesForSave,
  specialtyIsRequired,
  specialtyOptions,
} from '@/lib/professional-specialties';
import { WeeklyScheduleEditor } from '@/components/professionals/WeeklyScheduleEditor';
import { TimeOffManager } from '@/components/time-off/TimeOffManager';
import {
  defaultSchedule,
  hasProblems,
  scheduleFromWorkingHours,
  workingHoursFromSchedule,
  type WeeklySchedule,
} from '@/lib/weekly-schedule';

const statusOptions = ['active', 'inactive', 'blocked'] as const;

interface FormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  specialty: string;
  status: 'active' | 'inactive' | 'blocked';
  bio: string;
  serviceIds: string[];
}

interface FormErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  specialty?: string;
  bio?: string;
}

interface Service {
  id: string;
  name: string;
  category: string;
}

function EditProfessionalForm() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations();
  const professionalId = params?.id as string;

  const [formData, setFormData] = useState<FormData>({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    specialty: '',
    status: 'active',
    bio: '',
    serviceIds: [],
  });

  const [services, setServices] = useState<Service[]>([]);
  // The specialty as stored: shown as it is (free text included), required
  // only if there is one, and sent only when changed (lib/professional-specialties).
  const [originalSpecialty, setOriginalSpecialty] = useState('');
  const [errors, setErrors] = useState<FormErrors>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  // The weekly schedule. Null while none is recorded: such a professional is
  // bookable at any hour, and a default week is only shown once the salon
  // asks for one. Sent only when edited, so saving a name never rewrites it.
  const [schedule, setSchedule] = useState<WeeklySchedule | null>(null);
  const [scheduleTouched, setScheduleTouched] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  const editSchedule = (next: WeeklySchedule) => {
    setSchedule(next);
    setScheduleTouched(true);
    setScheduleError(null);
  };

  // Fetch services and professional data
  useEffect(() => {
    const fetchData = async () => {
      try {
        setIsLoading(true);
        
        // Fetch services
        // Through the API client. This fetched '/api/services', a Next route
        // that does not exist: the 404 left the list empty, and a network
        // error showed six invented services instead.
        try {
          const servicesData = await apiClient.getServices();
          setServices(servicesData as any);
        } catch (err) {
          console.error('Failed to fetch services:', err);
          setServices([]);
        }

        // Fetch professional data
        const professional = await apiClient.getProfessional(professionalId);
        if (professional) {
          // Extract service IDs from the nested structure
          const serviceIds = (professional as any).services?.map((ps: any) => ps.serviceId || ps.service?.id).filter(Boolean) || [];
           
          const specialty = currentSpecialty(professional.specialties);
          setOriginalSpecialty(specialty);
          setFormData({
            firstName: professional.firstName || '',
            lastName: professional.lastName || '',
            email: professional.email || '',
            phone: professional.phone || '',
            specialty,
            status: professional.isActive ? 'active' : 'inactive',
            bio: (professional as any).bio || '',
            serviceIds,
          });
          setSchedule(scheduleFromWorkingHours(professional.workingHours));
          setScheduleTouched(false);
        }
      } catch (err) {
        console.error('Failed to fetch professional:', err);
      } finally {
        setIsLoading(false);
      }
    };

    if (professionalId) {
      fetchData();
    }
  }, [professionalId]);

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    if (!formData.firstName.trim()) {
      newErrors.firstName = t('professionals.validation.firstNameRequired');
    }

    if (!formData.lastName.trim()) {
      newErrors.lastName = t('professionals.validation.lastNameRequired');
    }

    if (!formData.email.trim()) {
      newErrors.email = t('professionals.validation.emailRequired');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = t('professionals.validation.emailInvalid');
    }

    if (!formData.specialty && specialtyIsRequired(originalSpecialty)) {
      newErrors.specialty = t('professionals.validation.specialtyRequired');
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleServiceToggle = (serviceId: string) => {
    setFormData(prev => ({
      ...prev,
      serviceIds: prev.serviceIds.includes(serviceId)
        ? prev.serviceIds.filter(id => id !== serviceId)
        : [...prev.serviceIds, serviceId],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaveSuccess(false);

    if (!validateForm()) {
      return;
    }
    if (scheduleTouched && schedule && hasProblems(schedule)) {
      setScheduleError('Revisa el horario: hay tramos que no se pueden guardar.');
      return;
    }

    setIsSaving(true);
    setScheduleError(null);

    try {
      // Prepare update payload
      const updateData = {
        firstName: formData.firstName,
        lastName: formData.lastName,
        email: formData.email,
        phone: formData.phone || undefined,
        specialties: specialtiesForSave(originalSpecialty, formData.specialty),
        bio: formData.bio || undefined,
        isActive: formData.status === 'active',
        serviceIds: formData.serviceIds,
        ...(scheduleTouched && schedule ? { workingHours: workingHoursFromSchedule(schedule) } : {}),
      };

      await apiClient.updateProfessional(professionalId, updateData);
      
      setSaveSuccess(true);

      // Redirect after short delay
      setTimeout(() => {
        router.push(`/dashboard/professionals/${professionalId}`);
      }, 1500);
    } catch (err) {
      console.error('Error updating professional:', err);
      // A refused schedule comes back with its reason, in Spanish: show it
      // under the schedule rather than as an email error.
      const message = err instanceof Error ? err.message : '';
      if (scheduleTouched && /horario|tramo/i.test(message)) {
        setScheduleError(message);
      } else {
        setErrors({ ...errors, email: t('professionals.editPage.updateFailed') });
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name as keyof FormErrors]) {
      setErrors((prev) => ({ ...prev, [name]: undefined }));
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
       <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center space-x-4">
          <Link
            href={`/dashboard/professionals/${professionalId}`}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </Link>
          <div>
             <h1 className="text-2xl font-bold text-gray-900 truncate">{t('professionals.editPage.title')}</h1>
            <p className="text-gray-500 mt-1">{t('professionals.editPage.subtitle')}</p>
          </div>
        </div>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Success Message */}
        {saveSuccess && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg">
            {t('professionals.editPage.saved')}
          </div>
        )}

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-6">{t('professionals.editPage.infoTitle')}</h2>

           <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* First Name */}
            <div>
              <label htmlFor="firstName" className="block text-sm font-medium text-gray-700 mb-2">
                {t('professionals.fields.firstName')} *
              </label>
              <input
                type="text"
                id="firstName"
                name="firstName"
                value={formData.firstName}
                onChange={handleChange}
                className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors ${
                  errors.firstName ? 'border-red-500' : 'border-gray-300'
                }`}
                placeholder={t('professionals.fields.firstNamePlaceholder')}
              />
              {errors.firstName && (
                <p className="mt-1 text-sm text-red-500">{errors.firstName}</p>
              )}
            </div>

            {/* Last Name */}
            <div>
              <label htmlFor="lastName" className="block text-sm font-medium text-gray-700 mb-2">
                {t('professionals.fields.lastName')} *
              </label>
              <input
                type="text"
                id="lastName"
                name="lastName"
                value={formData.lastName}
                onChange={handleChange}
                className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors ${
                  errors.lastName ? 'border-red-500' : 'border-gray-300'
                }`}
                placeholder={t('professionals.fields.lastNamePlaceholder')}
              />
              {errors.lastName && (
                <p className="mt-1 text-sm text-red-500">{errors.lastName}</p>
              )}
            </div>

            {/* Email */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-2">
                {t('professionals.fields.email')} *
              </label>
              <input
                type="email"
                id="email"
                name="email"
                value={formData.email}
                onChange={handleChange}
                className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors ${
                  errors.email ? 'border-red-500' : 'border-gray-300'
                }`}
                placeholder={t('professionals.fields.emailPlaceholder')}
              />
              {errors.email && (
                <p className="mt-1 text-sm text-red-500">{errors.email}</p>
              )}
            </div>

            {/* Phone */}
            <div>
              <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-2">
                {t('professionals.fields.phone')}
              </label>
              <input
                type="tel"
                id="phone"
                name="phone"
                value={formData.phone}
                onChange={handleChange}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors"
                placeholder={t('professionals.fields.phonePlaceholder')}
              />
            </div>

            {/* Specialty */}
            <div>
              <label htmlFor="specialty" className="block text-sm font-medium text-gray-700 mb-2">
                {t('professionals.fields.specialty')}
                {specialtyIsRequired(originalSpecialty) && ' *'}
              </label>
              <select
                id="specialty"
                name="specialty"
                value={formData.specialty}
                onChange={handleChange}
                className={`w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors ${
                  errors.specialty ? 'border-red-500' : 'border-gray-300'
                }`}
              >
                <option value="">
                  {specialtyIsRequired(originalSpecialty)
                    ? t('professionals.fields.selectSpecialty')
                    : t('professionals.fields.noSpecialty')}
                </option>
                {specialtyOptions(originalSpecialty).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.labelKey ? t(option.labelKey) : option.value}
                  </option>
                ))}
              </select>
              {errors.specialty && (
                <p className="mt-1 text-sm text-red-500">{errors.specialty}</p>
              )}
            </div>

            {/* Status */}
            <div>
              <label htmlFor="status" className="block text-sm font-medium text-gray-700 mb-2">
                {t('professionals.fields.status')}
              </label>
              <select
                id="status"
                name="status"
                value={formData.status}
                onChange={handleChange}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors"
              >
                {statusOptions.map((option) => (
                  <option key={option} value={option}>
                    {t(`professionals.statusOptions.${option}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Bio */}
          <div className="mt-6">
            <label htmlFor="bio" className="block text-sm font-medium text-gray-700 mb-2">
              {t('professionals.fields.bio')}
            </label>
            <textarea
              id="bio"
              name="bio"
              value={formData.bio}
              onChange={handleChange}
              rows={4}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors resize-none"
              placeholder={t('professionals.fields.bioPlaceholder')}
            />
            <p className="mt-1 text-sm text-gray-500">{t('professionals.fields.bioHint')}</p>
          </div>

          {/* Services Selection */}
          <div className="mt-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {t('professionals.fields.servicesProvided')}
            </label>
             <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {services.map((service) => (
                <label
                  key={service.id}
                  className={`flex items-center p-3 border rounded-lg cursor-pointer transition-colors ${
                    formData.serviceIds.includes(service.id)
                      ? 'border-indigo-500 bg-indigo-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={formData.serviceIds.includes(service.id)}
                    onChange={() => handleServiceToggle(service.id)}
                    className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                  />
                  <span className="ml-2 text-sm text-gray-700">{service.name}</span>
                </label>
              ))}
            </div>
            {services.length === 0 && (
              <p className="text-sm text-gray-500 mt-2">
                {t('professionals.fields.noServices')}
              </p>
            )}
          </div>
        </div>

        {/* Weekly schedule */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-1">Horario semanal</h2>
          <p className="text-sm text-gray-500 mb-4">
            Las reservas online y la recepcionista solo ofrecen huecos dentro de estos tramos.
          </p>
          {schedule ? (
            <WeeklyScheduleEditor value={schedule} onChange={editSchedule} disabled={isSaving} />
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 p-4">
              <p className="text-sm text-gray-700">
                Este profesional no tiene horario registrado, así que se le puede reservar a cualquier hora en que
                el salón abre.
              </p>
              <button
                type="button"
                onClick={() => editSchedule(defaultSchedule())}
                className="mt-3 inline-flex items-center px-4 py-2 border border-indigo-600 text-indigo-700 rounded-lg hover:bg-indigo-50 transition-colors"
              >
                Definir horario
              </button>
            </div>
          )}
          {scheduleError && (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {scheduleError}
            </p>
          )}
        </div>

        {/* Action Buttons */}
         <div className="flex flex-col gap-2 justify-end sm:flex-row sm:items-center sm:gap-4">
          <Link
            href={`/dashboard/professionals/${professionalId}`}
            className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            {t('professionals.editPage.cancel')}
          </Link>
          <button
            type="submit"
            disabled={isSaving}
            className="inline-flex items-center px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t('professionals.editPage.saving')}
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                {t('professionals.editPage.save')}
              </>
            )}
          </button>
        </div>
      </form>

      {/* Outside the form: each absence is saved on its own, not with "Guardar cambios". */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Ausencias</h2>
        <p className="text-sm text-gray-500 mb-4">
          Vacaciones, días libres, bajas o unas horas sueltas. En ese tiempo no se ofrecen citas online ni por la
          recepcionista; las citas que ya tenga no se cancelan.
        </p>
        <TimeOffManager professionalId={professionalId} />
      </div>
    </div>
  );
}

export default function EditProfessionalPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    }>
      <EditProfessionalForm />
    </Suspense>
  );
}
