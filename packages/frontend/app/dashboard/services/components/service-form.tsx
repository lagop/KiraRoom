'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { useToast } from '@/components/ui/use-toast'
import api from '@/lib/api'

interface ServiceFormProps {
  initialData?: {
    id: string
    name: string
    description?: string | null
    category: 'hair' | 'nails' | 'facial' | 'massage' | 'body' | 'other'
    duration: number
    price: number
    currency: string
    isActive: boolean
    depositRequired?: boolean
    depositAmount?: number
    depositPercentage?: number
  }
  isEditing?: boolean
  onClose?: () => void
  onSubmit?: (data: any) => Promise<void>
}

const CATEGORIES = [
  { value: 'hair', label: 'Hair' },
  { value: 'nails', label: 'Nails' },
  { value: 'facial', label: 'Facial' },
  { value: 'massage', label: 'Massage' },
  { value: 'body', label: 'Body' },
  { value: 'other', label: 'Other' },
] as const

const CURRENCIES = [
  { value: 'USD', label: 'USD - US Dollar' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'GBP', label: 'GBP - British Pound' },
] as const

export function ServiceForm({ initialData, isEditing, onClose, onSubmit }: ServiceFormProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [formData, setFormData] = useState({
    name: initialData?.name || '',
    description: initialData?.description || '',
    category: (initialData?.category as typeof CATEGORIES[number]['value']) || 'hair',
    duration: initialData?.duration || 30,
    price: initialData?.price || 0,
    currency: initialData?.currency || 'USD',
    isActive: initialData?.isActive ?? true,
    depositRequired: initialData?.depositRequired ?? false,
    depositAmount: initialData?.depositAmount ?? 0,
    depositPercentage: initialData?.depositPercentage ?? 0,
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)

    try {
      if (onSubmit) {
        await onSubmit(formData)
      } else if (isEditing && initialData) {
        await api.updateService(initialData.id, formData)
        toast({
          title: 'Service updated',
          description: `${formData.name} has been updated successfully.`,
        })
      } else {
        await api.createService({
          tenantId: 'default-tenant',
          ...formData,
        })
        toast({
          title: 'Service created',
          description: `${formData.name} has been created successfully.`,
        })
      }

      if (onClose) {
        onClose()
      } else {
        router.push('/dashboard/services')
        router.refresh()
      }
    } catch (error) {
      console.error('Error saving service:', error)
      toast({
        title: 'Error',
        description: 'Failed to save service. Please try again.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle>{isEditing ? 'Edit Service' : 'Create New Service'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
           <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="name">Service Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Haircut & Style"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">Category *</Label>
              <select
                id="category"
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value as typeof formData.category })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </div>

             <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="description">Description</Label>
              <textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="Describe the service..."
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[100px]"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="duration">Duration (minutes) *</Label>
              <Input
                id="duration"
                type="number"
                min="5"
                step="5"
                value={formData.duration}
                onChange={(e) => setFormData({ ...formData, duration: parseInt(e.target.value) || 0 })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="currency">Currency *</Label>
              <select
                id="currency"
                value={formData.currency}
                onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              >
                {CURRENCIES.map((curr) => (
                  <option key={curr.value} value={curr.value}>
                    {curr.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="price">Price *</Label>
              <Input
                id="price"
                type="number"
                min="0"
                step="0.01"
                value={formData.price}
                onChange={(e) => setFormData({ ...formData, price: parseFloat(e.target.value) || 0 })}
                required
              />
            </div>

            {/* Deposit Settings Section */}
             <div className="sm:col-span-2 border-t pt-4 mt-4">
              <h3 className="text-sm font-medium text-gray-900 mb-3">Deposit Settings</h3>
               <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.depositRequired}
                      onChange={(e) => setFormData({ ...formData, depositRequired: e.target.checked })}
                      className="w-4 h-4"
                    />
                    Require Deposit
                  </Label>
                </div>

                {formData.depositRequired && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="depositAmount">Deposit Amount (Fixed)</Label>
                      <Input
                        id="depositAmount"
                        type="number"
                        min="0"
                        step="0.01"
                        value={formData.depositAmount}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          depositAmount: parseFloat(e.target.value) || 0,
                          depositPercentage: e.target.value ? 0 : formData.depositPercentage 
                        })}
                        placeholder="0.00"
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="depositPercentage">Deposit Percentage</Label>
                      <Input
                        id="depositPercentage"
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={formData.depositPercentage}
                        onChange={(e) => setFormData({ 
                          ...formData, 
                          depositPercentage: parseFloat(e.target.value) || 0,
                          depositAmount: e.target.value ? 0 : formData.depositAmount
                        })}
                        placeholder="0"
                      />
                      <p className="text-xs text-gray-500">% of total price</p>
                    </div>
                  </>
                )}
              </div>
            </div>

            {isEditing && (
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={formData.isActive}
                    onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                    className="w-4 h-4"
                  />
                  Active
                </Label>
              </div>
            )}
          </div>

           <div className="flex flex-col gap-2 pt-4 sm:flex-row sm:justify-end sm:gap-3">
            {onClose && (
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button type="submit" disabled={loading}>
              {loading ? 'Saving...' : isEditing ? 'Update Service' : 'Create Service'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
