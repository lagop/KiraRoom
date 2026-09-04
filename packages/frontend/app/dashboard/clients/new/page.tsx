"use client";

import { ClientForm } from "../components/client-form";
import { useTranslations } from "@/lib/use-translation";

export default function NewClientPage() {
  const t = useTranslations();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 truncate">
          {t("clients.addNew")}
        </h1>
        <p className="text-gray-500 mt-1">{t("clients.addNewDesc")}</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <ClientForm />
      </div>
    </div>
  );
}
