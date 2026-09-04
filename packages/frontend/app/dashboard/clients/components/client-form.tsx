'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, Loader2, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import apiClient from '@/lib/api';

interface ClientFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth?: string;
  gender?: 'male' | 'female' | 'other' | '';
  profileImage?: string;
  status: 'active' | 'inactive' | 'blocked';
  notes?: string;
  taxId?: string;
  taxIdType?: 'nif' | 'cif' | 'nie' | 'passport' | 'other';
}

interface ClientFormProps {
  initialData?: ClientFormData & { id?: string };
  clientId?: string;
}

export function ClientForm({ initialData, clientId }: ClientFormProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  
  const isEdit = !!clientId || (initialData?.id && typeof window !== 'undefined');
  
  const [formData, setFormData] = useState<ClientFormData>({
    firstName: initialData?.firstName || '',
    lastName: initialData?.lastName || '',
    email: initialData?.email || '',
    phone: initialData?.phone || '',
    dateOfBirth: initialData?.dateOfBirth || '',
    gender: initialData?.gender || '',
    profileImage: initialData?.profileImage || '',
    status: initialData?.status || 'active',
    notes: initialData?.notes || '',
    taxId: initialData?.taxId || '',
    taxIdType: initialData?.taxIdType || 'nif',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccess(false);

    try {
      // Get tenantId from stored user info
      let tenantId = 'default-tenant'; // Default tenantId for demo purposes
      const storedUser = typeof window !== 'undefined' ? localStorage.getItem('user') : null;
      
      if (storedUser) {
        const user = JSON.parse(storedUser);
        if (user.tenantId) {
          tenantId = user.tenantId;
        }
      }
      
      const data: Record<string, any> = {
        tenantId,
        firstName: formData.firstName,
        lastName: formData.lastName,
      };
      
      if (formData.email) data.email = formData.email;
      if (formData.phone) data.phone = formData.phone;
      if (formData.dateOfBirth) data.dateOfBirth = formData.dateOfBirth;
      if (formData.gender) data.gender = formData.gender;
      if (formData.profileImage) data.profileImage = formData.profileImage;
      if (formData.notes) data.notes = formData.notes;
      if (formData.taxId) {
        data.taxId = formData.taxId.toUpperCase().replace(/\s/g, "");
        data.taxIdType = formData.taxIdType;
      }

      if (isEdit && clientId) {
        await (apiClient as any).updateClient(clientId, data);
      } else {
        await (apiClient as any).createClient(data);
      }
      
      setSuccess(true);
      setTimeout(() => {
        router.push('/dashboard/clients');
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {success && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg">
          Client {isEdit ? 'updated' : 'created'} successfully! Redirecting...
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

       <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* First Name */}
        <div>
          <label htmlFor="firstName" className="block text-sm font-medium text-gray-700 mb-1">
            First Name *
          </label>
          <input
            type="text"
            id="firstName"
            name="firstName"
            value={formData.firstName}
            onChange={handleChange}
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="Enter first name"
          />
        </div>

        {/* Last Name */}
        <div>
          <label htmlFor="lastName" className="block text-sm font-medium text-gray-700 mb-1">
            Last Name *
          </label>
          <input
            type="text"
            id="lastName"
            name="lastName"
            value={formData.lastName}
            onChange={handleChange}
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="Enter last name"
          />
        </div>

        {/* Email */}
        <div>
          <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
            Email
          </label>
          <input
            type="email"
            id="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="Enter email address"
          />
        </div>

        {/* Phone */}
        <div>
          <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
            Phone
          </label>
          <input
            type="tel"
            id="phone"
            name="phone"
            value={formData.phone}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="Enter phone number"
          />
        </div>

        {/* NIF / CIF / NIE */}
        <div>
          <label htmlFor="taxId" className="block text-sm font-medium text-gray-700 mb-1">
            NIF / CIF / NIE
          </label>
          <input
            type="text"
            id="taxId"
            name="taxId"
            value={formData.taxId ?? ""}
            onChange={(e) =>
              setFormData((prev) => ({
                ...prev,
                taxId: e.target.value.toUpperCase(),
              }))
            }
            className="w-full px-4 py-2 border border-gray-300 rounded-lg uppercase focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="B12345678"
          />
        </div>

        {/* Tax ID Type */}
        <div>
          <label htmlFor="taxIdType" className="block text-sm font-medium text-gray-700 mb-1">
            Tipo
          </label>
          <select
            id="taxIdType"
            name="taxIdType"
            value={formData.taxIdType ?? "nif"}
            onChange={(e) =>
              setFormData((prev) => ({
                ...prev,
                taxIdType: e.target.value as
                  | "nif"
                  | "cif"
                  | "nie"
                  | "passport"
                  | "other",
              }))
            }
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          >
            <option value="nif">NIF</option>
            <option value="cif">CIF</option>
            <option value="nie">NIE</option>
            <option value="passport">Pasaporte</option>
            <option value="other">Otro</option>
          </select>
        </div>

        {/* Date of Birth */}
        <div>
          <label htmlFor="dateOfBirth" className="block text-sm font-medium text-gray-700 mb-1">
            Date of Birth
          </label>
          <input
            type="date"
            id="dateOfBirth"
            name="dateOfBirth"
            value={formData.dateOfBirth}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>

        {/* Gender */}
        <div>
          <label htmlFor="gender" className="block text-sm font-medium text-gray-700 mb-1">
            Gender
          </label>
          <select
            id="gender"
            name="gender"
            value={formData.gender}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          >
            <option value="">Select gender</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="other">Other</option>
          </select>
        </div>

        {/* Profile Image URL */}
         <div className="sm:col-span-2">
          <label htmlFor="profileImage" className="block text-sm font-medium text-gray-700 mb-1">
            Profile Image URL
          </label>
          <input
            type="url"
            id="profileImage"
            name="profileImage"
            value={formData.profileImage}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="https://example.com/profile-image.jpg"
          />
        </div>

        {/* Status (only for edit) */}
        {isEdit && (
          <div>
            <label htmlFor="status" className="block text-sm font-medium text-gray-700 mb-1">
              Status
            </label>
            <select
              id="status"
              name="status"
              value={formData.status}
              onChange={handleChange}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="blocked">Blocked</option>
            </select>
          </div>
        )}

        {/* Notes */}
         <div className="sm:col-span-2">
          <label htmlFor="notes" className="block text-sm font-medium text-gray-700 mb-1">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            value={formData.notes}
            onChange={handleChange}
            rows={4}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
            placeholder="Add notes about this client (e.g., hair color preferences, cutting preferences, allergies, etc.)"
          />
        </div>
      </div>

      {/* Form Actions */}
       <div className="flex flex-col gap-2 justify-end pt-6 border-t border-gray-200 sm:flex-row sm:items-center sm:gap-4">
        <Link
          href="/dashboard/clients"
          className="flex items-center px-4 py-2 text-gray-700 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Cancel
        </Link>
        <button
          type="submit"
          disabled={isLoading}
          className="flex items-center px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          {isEdit ? 'Update Client' : 'Create Client'}
        </button>
      </div>
    </form>
  );
}
