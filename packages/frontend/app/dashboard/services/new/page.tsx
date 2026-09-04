'use client'

import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { ServiceForm } from './components/service-form'
import apiClient from '@/lib/api'
import { useTranslations } from '@/lib/use-translation';

export default function NewServicePage() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const t = useTranslations()

  const handleSubmit = async (data: any) => {
    try {
      await apiClient.createService({
        ...data,
        tenantId: 'demo-tenant', // TODO: Get from auth context
        currency: 'EUR',
      })
      // Refresh onboarding checklist so the "create first service" step
      // flips to done immediately rather than waiting for the 30s poll.
      queryClient.invalidateQueries({ queryKey: ['onboarding', 'state'] })
      router.push('/dashboard/services')
    } catch (error) {
      console.error('Failed to create service:', error)
      throw error
    }
  }

  return (
    <div className="p-8">
      <div className="mb-8">
         <h1 className="text-3xl font-bold text-gray-900 truncate">{t("services.addNew")}</h1>
        <p className="text-gray-600 mt-2">{t("services.addNewDesc")}</p>
      </div>
      <ServiceForm onSubmit={handleSubmit} />
    </div>
  )
}
