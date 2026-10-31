'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense, useState, useEffect } from 'react';
import { ArrowLeft, Edit, Mail, Phone, Calendar, Percent, Briefcase } from 'lucide-react';
import apiClient from '@/lib/api';
import { useTranslations } from '@/lib/use-translation';
import { specialtyLabelKey } from '@/lib/professional-specialties';

function ProfessionalViewContent() {
  const params = useParams();
  const t = useTranslations();
  const professionalId = params?.id as string;
  const [professionalData, setProfessionalData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const fetchProfessional = async () => {
      try {
        const data = await apiClient.getProfessional(professionalId);
        setProfessionalData(data);
      } catch (err) {
        console.error('Failed to fetch professional:', err);
        setLoadFailed(true);
      } finally {
        setIsLoading(false);
      }
    };

    if (professionalId) {
      fetchProfessional();
    }
  }, [professionalId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (loadFailed || !professionalData) {
    return (
      <div className="space-y-6">
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 px-4 py-3 rounded-lg">
          {loadFailed
            ? t('professionals.detailPage.loadFailed')
            : t('professionals.detailPage.notFound')}
        </div>
      </div>
    );
  }

  if (!professionalData) {
    return (
      <div className="space-y-6">
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 px-4 py-3 rounded-lg">
          {t('professionals.detailPage.notFound')}
        </div>
      </div>
    );
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('es-ES', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
       <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center space-x-4">
          <Link
            href="/dashboard/professionals"
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 truncate">{t('professionals.detailPage.title')}</h1>
            <p className="text-gray-500 mt-1">{t('professionals.detailPage.subtitle')}</p>
          </div>
        </div>
        <Link
          href={`/dashboard/professionals/${professionalId}/edit`}
          className="inline-flex items-center px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Edit className="w-4 h-4 mr-2" />
          {t('professionals.detailPage.edit')}
        </Link>
      </div>

      {/* Professional Info Card */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Profile Header */}
        <div className="bg-gradient-to-r from-indigo-500 to-purple-600 px-6 py-8">
           <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center">
              <span className="text-indigo-600 font-bold text-3xl">
                {professionalData.firstName.charAt(0)}{professionalData.lastName.charAt(0)}
              </span>
            </div>
            <div className="text-white">
              <h2 className="text-2xl font-bold">{professionalData.firstName} {professionalData.lastName}</h2>
              <p className="text-indigo-100">{professionalData.specialties?.[0]
                  ? (() => {
                      const key = specialtyLabelKey(professionalData.specialties[0]);
                      return key ? t(key) : professionalData.specialties[0];
                    })()
                  : t('professionals.detailPage.noSpecialty')}</p>
            </div>
          </div>
        </div>

        {/* Bio */}
        <div className="p-6 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">{t('professionals.detailPage.about')}</h3>
          <p className="text-gray-600">{professionalData.bio || t('professionals.detailPage.noBio')}</p>
        </div>

        {/* Services */}
        <div className="p-6 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">{t('professionals.fields.servicesProvided')}</h3>
          <div className="flex flex-wrap gap-2">
            {professionalData.services && professionalData.services.length > 0 ? (
              professionalData.services.map((service: any) => (
                <span key={service.serviceId || service.service?.id} className="inline-flex px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-medium">
                  {service.service?.name || t('professionals.detailPage.unknownService')}
                </span>
              ))
            ) : (
              <span className="inline-flex px-3 py-1 bg-gray-100 text-gray-800 rounded-full text-sm font-medium">
                {t('professionals.detailPage.noServices')}
              </span>
            )}
          </div>
        </div>

        {/* Professional Information */}
        <div className="p-6 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">{t('professionals.detailPage.infoTitle')}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex items-start space-x-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Briefcase className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">{t('professionals.detailPage.position')}</p>
                <p className="font-medium text-gray-900">
                  {professionalData.position === 'professional'
                    ? t('professionals.detailPage.positionProfessional')
                    : professionalData.position || t('professionals.detailPage.notProvided')}
                </p>
              </div>
            </div>
            <div className="flex items-start space-x-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <Percent className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">{t('professionals.detailPage.commissionRate')}</p>
                <p className="font-medium text-gray-900">
                  {professionalData.commissionRate
                    ? `${professionalData.commissionRate}%`
                    : t('professionals.detailPage.notProvided')}
                </p>
              </div>
            </div>
            <div className="flex items-start space-x-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Calendar className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">{t('professionals.detailPage.hireDate')}</p>
                <p className="font-medium text-gray-900">{professionalData.hireDate ? formatDate(professionalData.hireDate) : t('professionals.detailPage.notProvided')}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Contact Information */}
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">{t('professionals.detailPage.contactTitle')}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex items-start space-x-3">
              <div className="p-2 bg-gray-100 rounded-lg">
                <Mail className="w-5 h-5 text-gray-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">{t('professionals.fields.email')}</p>
                <p className="font-medium text-gray-900">{professionalData.email || t('professionals.detailPage.notProvided')}</p>
              </div>
            </div>
            <div className="flex items-start space-x-3">
              <div className="p-2 bg-gray-100 rounded-lg">
                <Phone className="w-5 h-5 text-gray-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">{t('professionals.fields.phone')}</p>
                <p className="font-medium text-gray-900">{professionalData.phone || t('professionals.detailPage.notProvided')}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Status */}
        <div className="px-6 py-4 bg-gray-50 border-t border-gray-200">
           <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center space-x-3">
              <Calendar className="w-5 h-5 text-gray-500" />
              <div>
                <p className="text-sm text-gray-500">{t('professionals.detailPage.accountStatus')}</p>
                <span className={`inline-flex px-3 py-1 rounded-full text-sm font-medium ${
                  professionalData.isActive ? 'bg-green-100 text-green-800' :
                  'bg-gray-100 text-gray-800'
                }`}>
                  {professionalData.isActive
                    ? t('professionals.statusOptions.active')
                    : t('professionals.statusOptions.inactive')}
                </span>
              </div>
            </div>
            <div className="text-sm text-gray-500">
              {t('professionals.detailPage.joined', {
                date: professionalData.createdAt
                  ? formatDate(professionalData.createdAt)
                  : t('professionals.detailPage.notAvailable'),
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ProfessionalViewPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    }>
      <ProfessionalViewContent />
    </Suspense>
  );
}
