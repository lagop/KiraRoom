'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Save, Loader2, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import apiClient, { getToken } from '@/lib/api';

interface Service {
  id: string;
  name: string;
  category: string;
}

interface ProfessionalFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  profileImage: string;
  bio: string;
  specialty: string;
  position: string;
  commissionRate: number;
  hireDate: string;
  status: 'active' | 'inactive';
  serviceIds: string[];
  // Portfolio fields
  portfolioImages: string[];
  yearsExperience: number;
  languages: string;
  certifications: string;
}

interface ProfessionalFormProps {
  initialData?: ProfessionalFormData & { id?: string };
  professionalId?: string;
}

export function ProfessionalForm({ initialData, professionalId }: ProfessionalFormProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useMockData, setUseMockData] = useState(false);
  const [services, setServices] = useState<Service[]>([]);
  const [availableServices, setAvailableServices] = useState<Service[]>([]);
  
  const isEdit = !!professionalId || (initialData?.id && typeof window !== 'undefined');
  
  const [formData, setFormData] = useState<ProfessionalFormData>({
    firstName: initialData?.firstName || '',
    lastName: initialData?.lastName || '',
    email: initialData?.email || '',
    phone: initialData?.phone || '',
    profileImage: initialData?.profileImage || '',
    bio: initialData?.bio || '',
    specialty: initialData?.specialty || '',
    position: initialData?.position || '',
    commissionRate: initialData?.commissionRate || 0,
    hireDate: initialData?.hireDate || '',
    status: initialData?.status || 'active',
    serviceIds: initialData?.serviceIds || [],
    // Portfolio fields
    portfolioImages: initialData?.portfolioImages || [],
    yearsExperience: initialData?.yearsExperience || 0,
    languages: initialData?.languages || '',
    certifications: initialData?.certifications || '',
  });

  // Fetch services on mount
  useEffect(() => {
    const fetchServices = async () => {
      try {
        const response = await fetch('/api/services');
        if (response.ok) {
          const data = await response.json();
          // Handle both paginated and non-paginated responses
          const servicesData = data.data || data;
          setServices(servicesData);
          setAvailableServices(servicesData);
        }
      } catch (err) {
        console.error('Failed to fetch services:', err);
        // Mock data for demo
        setAvailableServices([
          { id: '1', name: 'Haircut', category: 'hair' },
          { id: '2', name: 'Hair Coloring', category: 'hair' },
          { id: '3', name: 'Manicure', category: 'nails' },
          { id: '4', name: 'Pedicure', category: 'nails' },
          { id: '5', name: 'Facial', category: 'facial' },
          { id: '6', name: 'Massage', category: 'massage' },
        ]);
      }
    };
    fetchServices();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ 
      ...prev, 
      [name]: name === 'commissionRate' ? parseFloat(value) || 0 : value 
    }));
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
    setIsLoading(true);
    setError(null);

    try {
      const token = getToken();
      
      // If no auth token, use demo mode
      if (!token) {
        setUseMockData(true);
        console.log('Demo mode: Professional form submitted', formData);
        await new Promise(resolve => setTimeout(resolve, 500));
        router.push('/dashboard/professionals');
        return;
      }

      // Get tenant ID from localStorage
      const tenantId = localStorage.getItem('tenantId') || '';
      
      if (isEdit && professionalId) {
        // Update existing professional
        await apiClient.updateProfessional(professionalId, {
          ...formData,
          tenantId,
          specialties: [formData.specialty],
          isActive: formData.status === 'active',
          portfolioImages: formData.portfolioImages,
          yearsExperience: formData.yearsExperience,
          languages: formData.languages ? formData.languages.split(',').map(l => l.trim()) : [],
          certifications: formData.certifications ? formData.certifications.split(',').map(c => c.trim()) : [],
        });
      } else {
        // Create new professional
        await (apiClient as any).createProfessional({
          ...formData,
          tenantId,
          specialties: [formData.specialty],
          isActive: formData.status === 'active',
          portfolioImages: formData.portfolioImages,
          yearsExperience: formData.yearsExperience,
          languages: formData.languages ? formData.languages.split(',').map(l => l.trim()) : [],
          certifications: formData.certifications ? formData.certifications.split(',').map(c => c.trim()) : [],
        });
      }
      
      router.push('/dashboard/professionals');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Demo Mode Notice */}
      {useMockData && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 flex items-start">
          <AlertCircle className="w-5 h-5 text-yellow-600 mr-3 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-yellow-800 font-medium">Demo Mode</p>
            <p className="text-yellow-700 text-sm mt-1">
              API authentication required. Form submission is simulated.
            </p>
          </div>
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
            Email *
          </label>
          <input
            type="email"
            id="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            required
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

        {/* Profile Image */}
        <div>
          <label htmlFor="profileImage" className="block text-sm font-medium text-gray-700 mb-1">
            Profile Image
          </label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) {
                const reader = new FileReader()
                reader.onloadend = () => {
                  setFormData(prev => ({ ...prev, profileImage: reader.result as string }))
                }
                reader.readAsDataURL(file)
              }
            }}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          {formData.profileImage && (
            <div className="mt-2">
              <img src={formData.profileImage} alt="Preview" className="w-20 h-20 object-cover rounded-lg" />
              <button
                type="button"
                onClick={() => setFormData(prev => ({ ...prev, profileImage: '' }))}
                className="text-red-500 text-sm mt-1"
              >
                Remove
              </button>
            </div>
          )}
        </div>

        {/* Position */}
        <div>
          <label htmlFor="position" className="block text-sm font-medium text-gray-700 mb-1">
            Position *
          </label>
          <input
            type="text"
            id="position"
            name="position"
            value={formData.position}
            onChange={handleChange}
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="e.g., Senior Stylist, Nail Technician"
          />
        </div>

        {/* Specialty */}
        <div>
          <label htmlFor="specialty" className="block text-sm font-medium text-gray-700 mb-1">
            Primary Specialty *
          </label>
          <input
            type="text"
            id="specialty"
            name="specialty"
            value={formData.specialty}
            onChange={handleChange}
            required
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="e.g., Hair Styling, Nail Art"
          />
        </div>

        {/* Commission Rate */}
        <div>
          <label htmlFor="commissionRate" className="block text-sm font-medium text-gray-700 mb-1">
            Commission Rate (%)
          </label>
          <input
            type="number"
            id="commissionRate"
            name="commissionRate"
            value={formData.commissionRate}
            onChange={handleChange}
            min="0"
            max="100"
            step="1"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="e.g., 40"
          />
        </div>

        {/* Hire Date */}
        <div>
          <label htmlFor="hireDate" className="block text-sm font-medium text-gray-700 mb-1">
            Hire Date
          </label>
          <input
            type="date"
            id="hireDate"
            name="hireDate"
            value={formData.hireDate}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
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
            </select>
          </div>
        )}

        {/* Bio */}
         <div className="sm:col-span-2">
          <label htmlFor="bio" className="block text-sm font-medium text-gray-700 mb-1">
            Bio
          </label>
          <textarea
            id="bio"
            name="bio"
            value={formData.bio}
            onChange={handleChange}
            rows={4}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="Enter a short bio for this professional..."
          />
        </div>

        {/* Services Selection */}
         <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Services Provided
          </label>
           <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {availableServices.map((service) => (
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
          {availableServices.length === 0 && (
            <p className="text-sm text-gray-500 mt-2">
              No services available. Please create services first.
            </p>
          )}
        </div>

        {/* Portfolio Section Header */}
         <div className="sm:col-span-2 mt-6">
          <h3 className="text-lg font-medium text-gray-900">Portfolio</h3>
          <p className="text-sm text-gray-500">Showcase this professional's work and qualifications</p>
        </div>

        {/* Years of Experience */}
        <div>
          <label htmlFor="yearsExperience" className="block text-sm font-medium text-gray-700 mb-1">
            Years of Experience
          </label>
          <input
            type="number"
            id="yearsExperience"
            name="yearsExperience"
            value={formData.yearsExperience}
            onChange={handleChange}
            min="0"
            max="50"
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="e.g., 5"
          />
        </div>

        {/* Languages */}
        <div>
          <label htmlFor="languages" className="block text-sm font-medium text-gray-700 mb-1">
            Languages Spoken
          </label>
          <input
            type="text"
            id="languages"
            name="languages"
            value={formData.languages}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="e.g., English, Spanish"
          />
          <p className="text-xs text-gray-500 mt-1">Comma-separated list</p>
        </div>

        {/* Certifications */}
         <div className="sm:col-span-2">
          <label htmlFor="certifications" className="block text-sm font-medium text-gray-700 mb-1">
            Certifications
          </label>
          <input
            type="text"
            id="certifications"
            name="certifications"
            value={formData.certifications}
            onChange={handleChange}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="e.g., Certified Colorist, Master Stylist"
          />
          <p className="text-xs text-gray-500 mt-1">Comma-separated list</p>
        </div>

        {/* Portfolio Images */}
         <div className="sm:col-span-2">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Portfolio Images
          </label>
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-4">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                const files = e.target.files
                if (files) {
                  const readers: Promise<string>[] = []
                  for (let i = 0; i < files.length; i++) {
                    readers.push(new Promise((resolve) => {
                      const reader = new FileReader()
                      reader.onloadend = () => resolve(reader.result as string)
                      reader.readAsDataURL(files[i])
                    }))
                  }
                  Promise.all(readers).then((images) => {
                    setFormData(prev => ({ ...prev, portfolioImages: [...prev.portfolioImages, ...images] }))
                  })
                }
              }}
              className="w-full"
            />
            <p className="text-xs text-gray-500 mt-2">Upload images of this professional's work</p>
          </div>
          {formData.portfolioImages.length > 0 && (
             <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {formData.portfolioImages.map((img, idx) => (
                <div key={idx} className="relative group">
                  <img src={img} alt={`Portfolio ${idx + 1}`} className="w-full h-20 object-cover rounded-lg" />
                  <button
                    type="button"
                    onClick={() => setFormData(prev => ({ ...prev, portfolioImages: prev.portfolioImages.filter((_, i) => i !== idx) }))}
                    className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Form Actions */}
       <div className="flex flex-col gap-2 justify-end pt-6 border-t border-gray-200 sm:flex-row sm:items-center sm:gap-4">
        <Link
          href="/dashboard/professionals"
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
          {isEdit ? 'Update Professional' : 'Create Professional'}
        </button>
      </div>
    </form>
  );
}
