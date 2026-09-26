"use client";

import { useState, useEffect } from "react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import {
  DollarSign,
  TrendingUp,
  Calendar,
  CheckCircle,
  Clock,
  AlertCircle,
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
}

interface CommissionSummary {
  professionalId: string;
  professionalName: string;
  totalEarnings: number;
  pendingCommission: number;
  paidCommission: number;
  appointments: CommissionAppointment[];
}

interface PayrollReport {
  period: { start: string; end: string };
  totalPayroll: number;
  professionals: {
    id: string;
    name: string;
    totalHours: number;
    totalSales: number;
    commission: number;
  }[];
}

export default function CommissionsPage() {
  const t = useTranslations();
  const [commissions, setCommissions] = useState<CommissionSummary[]>([]);
  const [payrollReport, setPayrollReport] = useState<PayrollReport | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"summary" | "payroll">("summary");
  const [selectedProfessional, setSelectedProfessional] = useState<
    string | null
  >(null);
  const [payingCommission, setPayingCommission] = useState(false);
  const [dateRange, setDateRange] = useState({
    startDate: new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      .toISOString()
      .split("T")[0],
    endDate: new Date().toISOString().split("T")[0],
  });

  useEffect(() => {
    loadCommissions();
  }, []);

  const loadCommissions = async () => {
    try {
      setLoading(true);
      const data = await apiClient.getAllCommissionSummaries();
      setCommissions(data);
    } catch (error) {
      console.error("Failed to load commissions:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadPayrollReport = async () => {
    try {
      setLoading(true);
      const data = await apiClient.getPayrollReport(
        dateRange.startDate,
        dateRange.endDate,
      );
      setPayrollReport(data);
    } catch (error) {
      console.error("Failed to load payroll report:", error);
    } finally {
      setLoading(false);
    }
  };

  const handlePayCommission = async (professionalId: string) => {
    if (
      !confirm(t("commissions.confirm_mark_all_paid"))
    ) {
      return;
    }

    try {
      setPayingCommission(true);
      await apiClient.payCommission(
        professionalId,
        [],
        dateRange.startDate,
        dateRange.endDate,
      );
      await loadCommissions();
      alert(t("commissions.commissions_paid_success"));
    } catch (error) {
      console.error("Failed to pay commission:", error);
      alert(t("commissions.failed_to_pay_commissions"));
    } finally {
      setPayingCommission(false);
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "EUR",
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const getTotalPending = () => {
    return commissions.reduce((sum, c) => sum + c.pendingCommission, 0);
  };

  const getTotalPaid = () => {
    return commissions.reduce((sum, c) => sum + c.paidCommission, 0);
  };

  const getTotalEarnings = () => {
    return commissions.reduce((sum, c) => sum + c.totalEarnings, 0);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">
            Staff Commissions
          </h1>
          <p className="text-gray-600">
            Track and manage staff commission payments
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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

        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                {t("commissions.title")}
              </h1>
              <p className="text-gray-600">{t("commissions.description")}</p>
            </div>
            <div className="bg-green-100 p-3 rounded-full">
              <CheckCircle className="w-6 h-6 text-green-600" />
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
              if (!payrollReport) loadPayrollReport();
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
          {commissions.length === 0 ? (
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
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">
                        {commission.professionalName}
                      </h3>
                      <p className="text-sm text-gray-500">
                        {commission.appointments.length}{" "}
                        {t("commissions.appointments")} •
                        {t("commissions.pending")}:{" "}
                        {formatCurrency(commission.pendingCommission)} •
                        {t("commissions.paid")}:{" "}
                        {formatCurrency(commission.paidCommission)}
                      </p>
                    </div>
                    <div className="flex space-x-3">
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
                          onClick={() =>
                            handlePayCommission(commission.professionalId)
                          }
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
                        {commission.appointments.map((apt) => (
                          <tr key={apt.id} className="hover:bg-gray-50">
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {formatDate(apt.date)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {apt.clientName}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              {apt.serviceName}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                              {formatCurrency(apt.amount)}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                              {apt.commissionRate}%
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
                        ))}
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
                disabled={loading}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
              >
                {t("commissions.generate_report")}
              </button>
            </div>
          </div>

          {payrollReport && (
            <>
              {/* Payroll Summary */}
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">
                      {t("commissions.payroll_summary")}
                    </h3>
                    <p className="text-sm text-gray-500">
                      {formatDate(payrollReport.period.start)} -{" "}
                      {formatDate(payrollReport.period.end)}
                    </p>
                  </div>
                  <div className="text-right">
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
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                            {formatCurrency(prof.totalSales)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 text-right">
                            {formatCurrency(prof.commission)}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                            {prof.totalSales > 0
                              ? (
                                  (prof.commission / prof.totalSales) *
                                  100
                                ).toFixed(1)
                              : 0}
                            %
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
