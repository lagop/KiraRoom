'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import apiClient from '@/lib/api';

interface Service {
  id: string;
  name: string;
  category: string;
}

export function ProfessionalForm() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [services, setServices] = useState<Service[]>([]);
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    phone: '',
    specialty: '',
    bio: '',
    avatarUrl: '',
  });

  // Fetch services on mount
  useEffect(() => {
    const fetchServices = async () => {
      try {
        // Get user info from localStorage (fallback to default tenant)
        const userStr = typeof window !== 'undefined' ? localStorage.getItem('kira_user') : null;
        const user = userStr ? JSON.parse(userStr) : { tenantId: 'default-tenant' };
        
        const servicesData = await apiClient.getServices(user.tenantId);
        setServices(servicesData);
      } catch (err) {
        console.error('Failed to fetch services:', err);
        // Mock data for demo
        setServices([
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

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleServiceToggle = (serviceId: string) => {
    setSelectedServices(prev =>
      prev.includes(serviceId)
        ? prev.filter(id => id !== serviceId)
        : [...prev, serviceId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      // Get user info from localStorage (fallback to default tenant)
      const userStr = typeof window !== 'undefined' ? localStorage.getItem('kira_user') : null;
      const user = userStr ? JSON.parse(userStr) : { tenantId: 'default-tenant' };
      
      const response = await apiClient.createProfessional({
        tenantId: user.tenantId,
        firstName: formData.firstName,
        lastName: formData.lastName,
        email: formData.email,
        phone: formData.phone,
        profileImage: formData.avatarUrl,
        bio: formData.bio,
        specialties: formData.specialty ? [formData.specialty] : [],
        position: 'professional',
        serviceIds: selectedServices,
      });

      router.push('/dashboard/professionals');
      router.refresh();
    } catch (error) {
      console.error('Error creating professional:', error);
      alert('Failed to create professional. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
       <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            value={formData.email}
            onChange={handleChange}
            required
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            value={formData.password}
            onChange={handleChange}
            required
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="firstName">First Name</Label>
          <Input
            id="firstName"
            name="firstName"
            value={formData.firstName}
            onChange={handleChange}
            required
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="lastName">Last Name</Label>
          <Input
            id="lastName"
            name="lastName"
            value={formData.lastName}
            onChange={handleChange}
            required
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            value={formData.phone}
            onChange={handleChange}
            disabled={isLoading}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="specialty">Specialty</Label>
          <Input
            id="specialty"
            name="specialty"
            value={formData.specialty}
            onChange={handleChange}
            placeholder="e.g., Hair Styling, Makeup Artist"
            disabled={isLoading}
          />
        </div>

         <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="avatarUrl">Avatar URL</Label>
          <Input
            id="avatarUrl"
            name="avatarUrl"
            type="url"
            value={formData.avatarUrl}
            onChange={handleChange}
            placeholder="https://example.com/avatar.jpg"
            disabled={isLoading}
          />
        </div>

         <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="bio">Bio</Label>
          <textarea
            id="bio"
            name="bio"
            value={formData.bio}
            onChange={handleChange}
            rows={4}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Write a short bio about the professional..."
            disabled={isLoading}
          />
        </div>

        {/* Services Selection */}
         <div className="space-y-2 sm:col-span-2">
          <Label>Services Provided</Label>
           <div className="grid grid-cols-1 gap-2 mt-2 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((service) => (
              <label
                key={service.id}
                className={`flex items-center p-3 border rounded-lg cursor-pointer transition-colors ${
                  selectedServices.includes(service.id)
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedServices.includes(service.id)}
                  onChange={() => handleServiceToggle(service.id)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                />
                <span className="ml-2 text-sm text-gray-700">{service.name}</span>
              </label>
            ))}
          </div>
          {services.length === 0 && (
            <p className="text-sm text-gray-500 mt-2">
              No services available. Please create services first.
            </p>
          )}
        </div>
      </div>

       <div className="flex flex-col gap-2 pt-4 border-t sm:flex-row sm:justify-end sm:gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={isLoading}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isLoading}>
          {isLoading ? 'Creating...' : 'Create Professional'}
        </Button>
      </div>
    </form>
  );
}
