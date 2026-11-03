"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { errorMessage, isPlanBlocked } from "@/lib/email-campaigns";
import {
  commissionShare,
  defaultPayrollRange,
  formatCommissionCents,
  formatCommissionDay,
} from "@/lib/commissions-format";
import {
  TrendingUp,
  CheckCircle,
  Clock,
  AlertCircle,
  Lock,
} from "lucide-react";

// Type definitions for commissions
interface CommissionAppointment {
  id: string;
  date: string;
  clientName: string;
  serviceName: string;
  amount: number;
  commissionRate: number;
  commissionAmount: number;
  paid: boolean;
  /**
   * "refund_adjustment": commission taken back by a refund given after it was
   * paid ("Ajuste por devolución"), negative, settled by the next payout.
   */
  source?: "appointment" | "sale" | "refund_adjustment";
  refundId?: string;
  /** refund_adjustment: the service or line it corrects. */
  description?: string;
}

interface CommissionSummary {
  professionalId: string;
  professionalName: string;
  /** false: deactivated, listed because something is still pending ("De baja"). */
  isActive?: boolean;
  totalEarnings: number;
  pendingCommission: number;
  paidCommission: number;
  appointments: CommissionAppointment[];
  /** The salon day the pending figure runs up to (today): what "Pagar" pays. */
  pendingUpTo?: string;
}

interface PayrollReport {
  period: { start: string; end: string };
  totalPayroll: number;
  professionals: {
    id: string;
    name: string;
    /** false: deactivated, listed for their work in the period ("De baja"). */
    isActive?: boolean;
    totalHours: number;
    totalSales: number;
    /** Net of the period's refund adjustments. */
    commission: number;
    /** "Ajuste por devolución": the period's refund adjustments (0 or negative). */
    refundAdjustments?: number;
  }[];
  /** Walk-in services sold with no professional named: nobody's commission. */
  unassignedServices?: { count: number; totalSales: number };
}

export default function CommissionsPage() {
  const t = useTranslations();
  const [commissions, setCommissions] = useState<CommissionSummary[]>([]);
  const [payrollReport, setPayrollReport] = useState<PayrollReport | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  // The summary could not be loaded (not an empty salon): shown with "Reintentar".
  const [loadError, setLoadError] = useState<string | null>(null);
  // The plan does not include commissions (403 FEATURE_NOT_IN_PLAN).
  const [planBlocked, setPlanBlocked] = useState(false);
  // The payroll report has its own loading and error: the page stays as it is.
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"summary" | "payroll">("summary");
  const [selectedProfessional, setSelectedProfessional] = useState<
    string | null
  >(null);
  const [payingCommission, setPayingCommission] = useState(false);
  // The professional whose pending commissions are about to be marked paid,
  // confirmed in the panel's dialog.
  const [pendingPay, setPendingPay] = useState<CommissionSummary | null>(null);
  const { toast } = useToast();
  // Both days included (the server counts the whole last day, salon time).
  const [dateRange, setDateRange] = useState(() => defaultPayrollRange());

  useEffect(() => {
    loadCommissions();
  }, []);

  const loadCommissions = async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await apiClient.getAllCommissionSummaries();
      setCommissions(data);
    } catch (error) {
      if (isPlanBlocked(error)) setPlanBlocked(true);
      else setLoadError(errorMessage(error, t("commissions.load_error")));
    } finally {
      setLoading(false);
    }
  };

  const loadPayrollReport = async () => {
    try {
      setReportLoading(true);
      setReportError(null);
      const data = await apiClient.getPayrollReport(
        dateRange.startDate,
        dateRange.endDate,
      );
      setPayrollReport(data);
    } catch (error) {
      // The previous report is not left on screen as if it were this one.
      setPayrollReport(null);
      setReportError(errorMessage(error, t("commissions.report_error")));
    } finally {
      setReportLoading(false);
    }
  };

  const performPayCommission = async () => {
    if (!pendingPay) return;
    try {
      setPayingCommission(true);
      // Everything pending up to today, as the dialog showed it -- not the
      // payroll tab's dates. If that figure changed meanwhile, the server
      // pays nothing and says so (409).
      await apiClient.payCommission(pendingPay.professionalId, {
        expectedAmount: pendingPay.pendingCommission,
      });
      await loadCommissions();
      toast({ title: t("commissions.commissions_paid_success") });
    } catch (error) {
      toast({
        title: t("commissions.failed_to_pay_commissions"),
        description: error instanceof Error && error.message ? error.message : undefined,
        variant: "destructive",
      });
      await loadCommissions();
    } finally {
      setPayingCommission(false);
      setPendingPay(null);
    }
  };

  // The API returns cents (lib/commissions-format.ts).
  const formatCurrency = formatCommissionCents;
  const formatDate = formatCommissionDay;

  const getTotalPending = () => {
    return commissions.reduce((sum, c) => sum + c.pendingCommission, 0);
  };

  const getTotalPaid = () => {
    return commissions.reduce((sum, c) => sum + c.paidCommission, 0);
  };

  const itemsLabel = (n: number) =>
    n === 1 ? t("commissions.item_one") : t("commissions.items", { count: n });

  const inactiveBadge = (
    <span className="ml-2 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 align-middle text-xs font-medium text-gray-600">
      {t("commissions.inactive")}
    </span>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const header = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 truncate">
          {t("commissions.page_title")}
        </h1>
        <p className="text-gray-600">{t("commissions.page_subtitle")}</p>
      </div>
    </div>
  );

  if (planBlocked) {
    return (
      <div className="space-y-6">
        {header}
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-6">
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
            <div className="space-y-2">
              <h2 className="font-semibold text-gray-900">
                {t("commissions.plan_blocked_title")}
              </h2>
              <p className="text-sm text-gray-700">
                {t("commissions.plan_blocked_body")}
              </p>
              <Link
                href="/dashboard/billing"
                className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                {t("commissions.plan_blocked_cta")}
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">
                {t("commissions.paid_commission")}
              </p>
              <p className="text-2xl font-bold text-green-600">
                {formatCurrency(getTotalPaid())}
              </p>
            </div>
            <div className="bg-blue-100 p-3 rounded-full">
              <TrendingUp className="w-6 h-6 text-blue-600" />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">
                {t("commissions.pending_commission")}
              </p>
              <p className="text-2xl font-bold text-yellow-600">
                {formatCurrency(getTotalPending())}
              </p>
            </div>
            <div className="bg-yellow-100 p-3 rounded-full">
              <Clock className="w-6 h-6 text-yellow-600" />
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex flex-wrap gap-x-8">
          <button
            onClick={() => setActiveTab("summary")}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === "summary"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {t("commissions.commission_summary")}
          </button>
          <button
            onClick={() => {
              setActiveTab("payroll");
              if (!payrollReport && !reportLoading) loadPayrollReport();
            }}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === "payroll"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {t("commissions.payroll_report")}
          </button>
        </nav>
      </div>

      {/* Summary Tab */}
      {activeTab === "summary" && (
        <div className="space-y-6">
          {loadError ? (
            <div role="alert" className="bg-white rounded-lg shadow p-12 text-center">
              <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                {t("commissions.load_error")}
              </h3>
              <p className="text-gray-500 mb-4">{loadError}</p>
              <button
                onClick={loadCommissions}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium"
              >
                {t("commissions.retry")}
              </button>
            </div>
          ) : commissions.length === 0 ? (
            <div className="bg-white rounded-lg shadow p-12 text-center">
              <AlertCircle className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                {t("commissions.no_commission_data")}
              </h3>
              <p className="text-gray-500">
                {t("commissions.complete_appointments_message")}
              </p>
            </div>
          ) : (
            commissions.map((commission) => (
              <div
                key={commission.professionalId}
                className="bg-white rounded-lg shadow overflow-hidden"
              >
                <div className="p-6 border-b border-gray-200">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <h3 className="text-lg font-semibold text-gray-900">
                        {commission.professionalName}
                        {commission.isActive === false && inactiveBadge}
                      </h3>
                      <p className="text-sm text-gray-500">
                        {itemsLabel(commission.appointments.length)}
                        {" • "}
                        {t("commissions.pending")}:{" "}
                        {formatCurrency(commission.pendingCommission)}
                        {" • "}
                        {t("commissions.paid")}:{" "}
                        {formatCurrency(commission.paidCommission)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        onClick={() =>
                          setSelectedProfessional(
                            selectedProfessional === commission.professionalId
                              ? null
                              : commission.professionalId,
                          )
                        }
                        className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                      >
                        {selectedProfessional === commission.professionalId
                          ? t("commissions.hide_details")
                          : t("commissions.view_details")}
                      </button>
                      {commission.pendingCommission > 0 && (
                        <button
                          onClick={() => setPendingPay(commission)}
                          disabled={payingCommission}
                          className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
                        >
                          {payingCommission
                            ? t("commissions.processing")
                            : t("commissions.pay_commission")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Appointments List */}
                {selectedProfessional === commission.professionalId && (
                  <div className="overflow-x-auto">
                    <table className="min-w-[820px] w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {t("commissions.date")}
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {t("commissions.client")}
                          </th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {t("commissions.service")}
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {t("commissions.amount")}
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {t("commissions.rate")}
                          </th>
                          <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {t("commissions.commission")}
                          </th>
                          <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {t("commissions.status")}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {commission.appointments.map((apt) => {
                          const adjustment = apt.source === "refund_adjustment";
                          return (
                          <tr key={apt.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {formatDate(apt.date)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {apt.clientName}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {adjustment
                                ? `${t("commissions.refund_adjustment")}${apt.description ? `: ${apt.description}` : ""}`
                                : apt.serviceName}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                              {adjustment ? "—" : formatCurrency(apt.amount)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                              {adjustment ? "—" : `${apt.commissionRate}%`}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 text-right">
                              {formatCurrency(apt.commissionAmount)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-center">
                              {apt.paid ? (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                  <CheckCircle className="w-3 h-3 mr-1" />{" "}
                                  {t("commissions.paid")}
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                                  <Clock className="w-3 h-3 mr-1" />{" "}
                                  {t("commissions.pending")}
                                </span>
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
            ))
          )}
        </div>
      )}

      {/* Payroll Tab */}
      {activeTab === "payroll" && (
        <div className="space-y-6">
          {/* Date Range Selector */}
          <div className="bg-white rounded-lg shadow p-6">
            <p className="mb-4 text-sm text-gray-500">
              {t("commissions.payroll_report_only")}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("commissions.start_date")}
                </label>
                <input
                  type="date"
                  value={dateRange.startDate}
                  onChange={(e) =>
                    setDateRange({ ...dateRange, startDate: e.target.value })
                  }
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("commissions.end_date")}
                </label>
                <input
                  type="date"
                  value={dateRange.endDate}
                  onChange={(e) =>
                    setDateRange({ ...dateRange, endDate: e.target.value })
                  }
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button
                onClick={loadPayrollReport}
                disabled={reportLoading}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
              >
                {reportLoading
                  ? t("commissions.generating")
                  : t("commissions.generate_report")}
              </button>
            </div>
          </div>

          {reportLoading && (
            <div className="flex items-center justify-center h-32" aria-busy="true">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          )}

          {!reportLoading && reportError && (
            <div role="alert" className="bg-white rounded-lg shadow p-6 text-center">
              <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-2" />
              <p className="font-medium text-gray-900">{t("commissions.report_error")}</p>
              <p className="text-sm text-gray-500 mb-4">{reportError}</p>
              <button
                onClick={loadPayrollReport}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium"
              >
                {t("commissions.retry")}
              </button>
            </div>
          )}

          {!reportLoading && payrollReport && (
            <>
              {/* Payroll Summary */}
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">
                      {t("commissions.payroll_summary")}
                    </h3>
                    <p className="text-sm text-gray-500">
                      {formatDate(payrollReport.period.start)} -{" "}
                      {formatDate(payrollReport.period.end)}
                    </p>
                  </div>
                  <div className="sm:text-right">
                    <p className="text-sm text-gray-500">
                      {t("commissions.total_payroll")}
                    </p>
                    <p className="text-2xl font-bold text-gray-900">
                      {formatCurrency(payrollReport.totalPayroll)}
                    </p>
                  </div>
                </div>
              </div>

              {/* Payroll Table */}
              <div className="bg-white rounded-lg shadow overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="min-w-[720px] w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          {t("commissions.professional")}
                        </th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          {t("commissions.total_sales")}
                        </th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          {t("commissions.refund_adjustment")}
                        </th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          {t("commissions.commission")}
                        </th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          {t("commissions.percentage_of_sales")}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {payrollReport.professionals.map((prof) => (
                        <tr key={prof.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                            {prof.name}
                            {prof.isActive === false && inactiveBadge}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                            {formatCurrency(prof.totalSales)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                            {prof.refundAdjustments ? formatCurrency(prof.refundAdjustments) : "—"}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 text-right">
                            {formatCurrency(prof.commission)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                            {commissionShare(prof.commission, prof.totalSales)}
                          </td>
                        </tr>
                      ))}
                      {/* Sold at the till with nobody named: nobody's commission, but seen. */}
                      {payrollReport.unassignedServices && payrollReport.unassignedServices.count > 0 && (
                        <tr className="bg-amber-50">
                          <td className="px-6 py-4 text-sm font-medium text-amber-900">
                            {t("commissions.unassigned_services")}
                            <span className="block text-xs font-normal text-amber-800">
                              {t("commissions.unassigned_services_hint", {
                                count: payrollReport.unassignedServices.count,
                              })}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-amber-900 text-right">
                            {formatCurrency(payrollReport.unassignedServices.totalSales)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-amber-900 text-right">—</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-amber-900 text-right">—</td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-amber-900 text-right">—</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!pendingPay}
        title={t("commissions.confirm_mark_all_paid")}
        description={
          pendingPay &&
          t("commissions.confirm_mark_paid_description", {
            name: pendingPay.professionalName,
            amount: formatCurrency(pendingPay.pendingCommission),
            date: formatDate(pendingPay.pendingUpTo ?? null),
          })
        }
        confirmLabel={t("commissions.mark_paid")}
        loading={payingCommission}
        onCancel={() => setPendingPay(null)}
        onConfirm={performPayCommission}
      />
    </div>
  );
}
