"use client";

import { InvoiceForm } from "./components/invoice-form";
import { useTranslations } from "@/lib/use-translation";

export default function NewInvoicePage() {
  const t = useTranslations();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          {t("invoices.newInvoice")}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {t("invoices.form.subtitle")}
        </p>
      </div>

      <InvoiceForm />
    </div>
  );
}
