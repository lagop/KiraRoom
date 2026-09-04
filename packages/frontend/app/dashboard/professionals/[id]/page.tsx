'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Suspense, useState, useEffect } from 'react';
import { ArrowLeft, Edit, Mail, Phone, Calendar, User, Clock, Star, MapPin, Percent, Briefcase } from 'lucide-react';
import apiClient from '@/lib/api';

function ProfessionalViewContent() {
  const params = useParams();
  const professionalId = params?.id as string;
  const [professionalData, setProfessionalData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchProfessional = async () => {
      try {
        const data = await apiClient.getProfessional(professionalId);
        setProfessionalData(data);
      } catch (err) {
        console.error('Failed to fetch professional:', err);
        setError('Failed to load professional data');
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

  if (error || !professionalData) {
    return (
      <div className="space-y-6">
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 px-4 py-3 rounded-lg">
          {error || 'Professional not found'}
        </div>
      </div>
    );
  }

  if (!professionalData) {
    return (
      <div className="space-y-6">
        <div className="bg-yellow-50 border border-yellow-200 text-yellow-700 px-4 py-3 rounded-lg">
          Professional not found
        </div>
      </div>
    );
  }

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
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
            <h1 className="text-2xl font-bold text-gray-900 truncate">Professional Details</h1>
            <p className="text-gray-500 mt-1">View professional information</p>
          </div>
        </div>
        <Link
          href={`/dashboard/professionals/${professionalId}/edit`}
          className="inline-flex items-center px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
        >
          <Edit className="w-4 h-4 mr-2" />
          Edit Professional
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
              <p className="text-indigo-100">{professionalData.specialties?.[0] || 'Not specified'}</p>
              <div className="flex flex-wrap items-center gap-4 mt-2">
                <div className="flex items-center">
                  <Star className="w-4 h-4 text-yellow-400 fill-current" />
                  <span className="ml-1 text-sm">4.8</span>
                </div>
                <div className="flex items-center">
                  <User className="w-4 h-4 text-indigo-200" />
                  <span className="ml-1 text-sm">156 clients</span>
                </div>
                <div className="flex items-center">
                  <Clock className="w-4 h-4 text-indigo-200" />
                  <span className="ml-1 text-sm">10 years</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bio */}
        <div className="p-6 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">About</h3>
          <p className="text-gray-600">{professionalData.bio || 'No bio available'}</p>
        </div>

        {/* Services */}
        <div className="p-6 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Services Provided</h3>
          <div className="flex flex-wrap gap-2">
            {professionalData.services && professionalData.services.length > 0 ? (
              professionalData.services.map((service: any) => (
                <span key={service.serviceId || service.service?.id} className="inline-flex px-3 py-1 bg-blue-100 text-blue-800 rounded-full text-sm font-medium">
                  {service.service?.name || 'Unknown Service'}
                </span>
              ))
            ) : (
              <span className="inline-flex px-3 py-1 bg-gray-100 text-gray-800 rounded-full text-sm font-medium">
                No services assigned
              </span>
            )}
          </div>
        </div>

        {/* Professional Information */}
        <div className="p-6 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Professional Information</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex items-start space-x-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Briefcase className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Position</p>
                <p className="font-medium text-gray-900">{professionalData.position || 'Not provided'}</p>
              </div>
            </div>
            <div className="flex items-start space-x-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <Percent className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Commission Rate</p>
                <p className="font-medium text-gray-900">{professionalData.commissionRate || 'Not provided'}%</p>
              </div>
            </div>
            <div className="flex items-start space-x-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Calendar className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Hire Date</p>
                <p className="font-medium text-gray-900">{professionalData.hireDate ? formatDate(professionalData.hireDate) : 'Not provided'}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Contact Information */}
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Contact Information</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex items-start space-x-3">
              <div className="p-2 bg-gray-100 rounded-lg">
                <Mail className="w-5 h-5 text-gray-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Email</p>
                <p className="font-medium text-gray-900">{professionalData.email || 'Not provided'}</p>
              </div>
            </div>
            <div className="flex items-start space-x-3">
              <div className="p-2 bg-gray-100 rounded-lg">
                <Phone className="w-5 h-5 text-gray-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Phone</p>
                <p className="font-medium text-gray-900">{professionalData.phone || 'Not provided'}</p>
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
                <p className="text-sm text-gray-500">Account Status</p>
                <span className={`inline-flex px-3 py-1 rounded-full text-sm font-medium ${
                  professionalData.isActive ? 'bg-green-100 text-green-800' :
                  'bg-gray-100 text-gray-800'
                }`}>
                  {professionalData.isActive ? 'active' : 'inactive'}
                </span>
              </div>
            </div>
            <div className="text-sm text-gray-500">
              Joined: {professionalData.createdAt ? formatDate(professionalData.createdAt) : 'Not available'}
            </div>
          </div>
        </div>
      </div>

      {/* Additional Actions */}
       <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="bg-white rounded-xl border border-gray-200 p-6 hover:shadow-md transition-shadow cursor-pointer">
          <div className="flex items-center space-x-3">
            <div className="p-3 bg-blue-100 rounded-lg">
              <Calendar className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <p className="font-medium text-gray-900">View Schedule</p>
              <p className="text-sm text-gray-500">View professional availability</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-6 hover:shadow-md transition-shadow cursor-pointer">
          <div className="flex items-center space-x-3">
            <div className="p-3 bg-green-100 rounded-lg">
              <User className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <p className="font-medium text-gray-900">Client List</p>
              <p className="text-sm text-gray-500">View assigned clients</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-red-200 p-6 hover:shadow-md transition-shadow cursor-pointer">
          <div className="flex items-center space-x-3">
            <div className="p-3 bg-red-100 rounded-lg">
              <User className="w-6 h-6 text-red-600" />
            </div>
            <div>
              <p className="font-medium text-red-900">Deactivate</p>
              <p className="text-sm text-gray-500">Disable professional access</p>
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
