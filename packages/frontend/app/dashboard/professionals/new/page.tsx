"use client";

import { ProfessionalForm } from './components/professional-form';
import { useTranslations } from '@/lib/use-translation';

export default function NewProfessionalPage() {
  const t = useTranslations();
  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
         <h1 className="text-2xl font-bold text-gray-900 truncate">{t("professionals.addNew")}</h1>
        <p className="text-gray-600 mt-1">{t("professionals.addNewDesc")}</p>
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <ProfessionalForm />
      </div>
    </div>
  );
}
