"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { formatDateEs } from "@/lib/saas-tenant";
import {
  type BillingInvoiceList,
  formatCents,
  invoiceAmountCents,
  invoiceStatusClass,
  conceptLabel,
  invoiceStatusKey,
  safeStripeUrl,
} from "@/lib/saas-billing";

/** The salon's latest plan invoices, test ones marked, from the console's copy of Stripe's. */
export function TenantInvoices({ tenantId }: { tenantId: string }) {
  const t = useTranslations();
  const [list, setList] = useState<BillingInvoiceList | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    apiClient
      .getSaasBillingInvoices({ tenantId, mode: "all", limit: 12 })
      .then((l: BillingInvoiceList) => setList(l))
      .catch(() => setFailed(true));
  }, [tenantId]);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">{t("saas.billing.tenant_title")}</h2>
        <Link href={`/saas/cobros?tenantId=${tenantId}`} className="text-sm text-indigo-700 hover:underline">
          {t("saas.billing.tenant_see_all")}
        </Link>
      </div>
      {failed ? (
        <p className="text-sm text-red-700">{t("saas.billing.load_error")}</p>
      ) : !list ? (
        <p className="text-sm text-gray-500">…</p>
      ) : list.items.length === 0 ? (
        <p className="text-sm text-gray-500">{t("saas.billing.tenant_empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <tbody>
              {list.items.map((inv) => {
                const key = invoiceStatusKey(inv.status);
                const view = safeStripeUrl(inv.hostedInvoiceUrl);
                const pdf = safeStripeUrl(inv.invoicePdfUrl);
                return (
                  <tr key={inv.id} className="border-b border-gray-100">
                    <td className="py-2 pr-4 whitespace-nowrap">{formatDateEs(inv.paidAt ?? inv.failedAt ?? inv.invoiceCreatedAt)}</td>
                    <td className="py-2 pr-4">{conceptLabel(inv.description, t) ?? inv.number ?? "—"}</td>
                    <td className="py-2 pr-4 text-right whitespace-nowrap">{formatCents(invoiceAmountCents(inv))}</td>
                    <td className="py-2 pr-4">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${invoiceStatusClass(inv.status)}`}>
                        {key ? t(key) : inv.status}
                      </span>
                      {!inv.livemode && (
                        <span className="ml-2 inline-flex px-2 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-800">
                          {t("saas.billing.test_badge")}
                        </span>
                      )}
                    </td>
                    <td className="py-2 whitespace-nowrap">
                      {view && (
                        <a href={view} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-700 hover:underline mr-3">
                          {t("saas.billing.view_invoice")} <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                      {pdf && (
                        <a href={pdf} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline">
                          {t("saas.billing.download_pdf")}
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
