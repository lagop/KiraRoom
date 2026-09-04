'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { ServiceForm } from '../components/service-form'

interface Service {
  id: string
  name: string
  description: string
  duration: number
  price: number
  category: string
  currency: string
  isActive: boolean
}

export default function EditServicePage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [service, setService] = useState<Service | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchService = async () => {
      try {
        const res = await fetch(`/api/services/${params.id}`)
        if (!res.ok) throw new Error('Service not found')
        const data = await res.json()
        setService(data)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load service')
      } finally {
        setLoading(false)
      }
    }

    if (params.id) {
      fetchService()
    }
  }, [params.id])



  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <svg className="animate-spin h-8 w-8 mx-auto text-indigo-600" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <p className="mt-4 text-gray-600">Loading service...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <div className="text-red-500 mb-4">
          <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 className="text-lg font-medium text-gray-900 mb-2">Error Loading Service</h3>
        <p className="text-gray-600 mb-4">{error}</p>
        <button
          onClick={() => router.back()}
          className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
        >
          Go Back
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
       <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
         <div>
           <h1 className="text-2xl font-bold text-gray-900 truncate">Edit Service</h1>
          <p className="text-gray-600 mt-1">Update service details</p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        {service && (
          <ServiceForm
            initialData={{
              ...service,
              category: service.category as 'hair' | 'nails' | 'facial' | 'massage' | 'body' | 'other',
            }}
            isEditing
          />
        )}
      </div>
    </div>
  )
}
