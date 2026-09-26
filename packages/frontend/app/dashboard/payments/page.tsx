"use client";

import { useState, useEffect } from "react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

// Type definitions for payments
interface Payment {
  id: string;
  tenantId: string;
  clientId?: string;
  appointmentId?: string;
  amount: number;
  currency: string;
  type:
    | "appointment"
    | "deposit"
    | "product"
    | "service"
    | "gift_card"
    | "membership"
    | "other";
  status:
    | "pending"
    | "processing"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "refunded"
    | "partially_refunded";
  method: "card" | "cash" | "bank_transfer" | "wallet";
  stripePaymentId?: string;
  stripeInvoiceId?: string;
  description?: string;
  metadata?: Record<string, any>;
  receiptUrl?: string;
  failureMessage?: string;
  isDeposit?: boolean;
  depositAmount?: number;
  remainingAmount?: number;
  createdAt: string;
  updatedAt: string;
  paidAt?: string;
  // Relations
  client?: {
    id: string;
    firstName: string;
    lastName: string;
    email?: string;
  };
  appointment?: {
    id: string;
    scheduledDate: string;
    status: string;
  };
}

interface PaymentSummary {
  totalRevenue: number;
  totalTransactions: number;
  pendingAmount: number;
  refundedAmount: number;
}

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [summary, setSummary] = useState<PaymentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<
    "all" | "subscriptions" | "wallet"
  >("all");

  // Filter states
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [methodFilter, setMethodFilter] = useState<string>("");
  const [dateFromFilter, setDateFromFilter] = useState<string>("");
  const [dateToFilter, setDateToFilter] = useState<string>("");

  // Pagination states
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [totalPayments, setTotalPayments] = useState<number>(0);

  // Sorting states
  const [sortBy, setSortBy] = useState<string>("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const t = useTranslations();

  useEffect(() => {
    loadPayments();
  }, [
    statusFilter,
    methodFilter,
    dateFromFilter,
    dateToFilter,
    currentPage,
    pageSize,
    sortBy,
    sortOrder,
  ]);

  const loadPayments = async () => {
    try {
      setLoading(true);

      // Get tenantId from localStorage first
      const token = localStorage.getItem("kira_auth_token");
      let tenantId: string | undefined;

      console.log("Auth token exists:", !!token);

      if (token) {
        try {
          // Decode JWT to get tenantId
          const payload = JSON.parse(atob(token.split(".")[1]));
          tenantId = payload.tenantId;
          console.log("Decoded tenantId:", tenantId);
        } catch (e) {
          console.error("Failed to decode token:", e);
        }
      } else {
        console.warn("No auth token found in localStorage");
      }

      // Build filter params for API
      const paymentsParams: any = tenantId ? { tenantId } : {};
      if (statusFilter) {
        paymentsParams.status = statusFilter;
      }
      paymentsParams.page = currentPage;
      paymentsParams.limit = pageSize;
      if (sortBy) paymentsParams.sortBy = sortBy;
      if (sortOrder) paymentsParams.sortOrder = sortOrder;
      console.log("Payments API call params:", paymentsParams);

      // Load payments and summary in parallel
      const [paymentsResponse, summaryData] = await Promise.all([
        apiClient.getPayments(paymentsParams).catch((error) => {
          console.error("Payments API error:", error);
          return {
            payments: [],
            pagination: {
              page: currentPage,
              limit: pageSize,
              total: 0,
              totalPages: 0,
            },
          };
        }),
        tenantId
          ? apiClient.getPaymentSummary(tenantId).catch((error) => {
              console.error("Summary API error:", error);
              return null;
            })
          : Promise.resolve(null),
      ]);

      let paymentsArray: Payment[] = paymentsResponse.payments as Payment[];

      // Extract pagination info
      if (paymentsResponse?.pagination) {
        setTotalPages(paymentsResponse.pagination.totalPages);
        setTotalPayments(paymentsResponse.pagination.total);
      }

      // Apply frontend filters (method and date) that aren't supported by backend
      if (methodFilter || dateFromFilter || dateToFilter) {
        console.log("Applying frontend filters:", {
          methodFilter,
          dateFromFilter,
          dateToFilter,
        });
        paymentsArray = paymentsArray.filter((payment) => {
          // Filter by method
          if (methodFilter && payment.method !== methodFilter) {
            return false;
          }

          // Filter by date range (compare date strings to avoid timezone issues)
          if (dateFromFilter || dateToFilter) {
            const paymentDateStr = payment.createdAt.substring(0, 10); // "YYYY-MM-DD"
            if (dateFromFilter && paymentDateStr < dateFromFilter) {
              return false;
            }
            if (dateToFilter && paymentDateStr > dateToFilter) {
              return false;
            }
          }

          return true;
        });
        console.log(
          "After frontend filtering:",
          paymentsArray.length,
          "payments",
        );
      }

      console.log("Payments loaded:", paymentsArray.length, "payments");
      if (paymentsArray.length > 0) {
        console.log("First payment keys:", Object.keys(paymentsArray[0]));
      }
      console.log("Summary data loaded:", summaryData);

      setPayments(paymentsArray);
      setSummary(summaryData);
    } catch (error) {
      console.error("Failed to load payments:", error);
      setPayments([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  };

  const formatCurrency = (
    amount: number | undefined | null,
    currency: string = "EUR",
  ) => {
    const validAmount =
      typeof amount === "number" && !isNaN(amount) ? amount : 0;
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency,
    }).format(validAmount / 100);
  };

  const formatNumber = (value: number | undefined | null) => {
    const validValue = typeof value === "number" && !isNaN(value) ? value : 0;
    return validValue.toString();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "succeeded":
      case "completed":
      case "paid":
        return "bg-green-100 text-green-800";
      case "pending":
      case "processing":
      case "trialing":
        return "bg-yellow-100 text-yellow-800";
      case "failed":
      case "cancelled":
        return "bg-red-100 text-red-800";
      case "refunded":
        return "bg-gray-100 text-gray-800";
      default:
        return "bg-blue-100 text-blue-800";
    }
  };

  const handleSort = (column: string) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortOrder("asc");
    }
    setCurrentPage(1); // Reset to first page when sorting changes
  };

  const getSortIcon = (column: string) => {
    if (sortBy !== column) {
      return (
        <svg
          className="w-4 h-4 inline-block ml-1 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"
          />
        </svg>
      );
    }
    return sortOrder === "asc" ? (
      <svg
        className="w-4 h-4 inline-block ml-1 text-blue-600"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M5 15l7-7 7 7"
        />
      </svg>
    ) : (
      <svg
        className="w-4 h-4 inline-block ml-1 text-blue-600"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M19 9l-7 7-7-7"
        />
      </svg>
    );
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
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">
            {t("payments.title")}
          </h1>
          <p className="text-gray-600">{t("payments.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => loadPayments()}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                Loading...
              </>
            ) : (
              <>
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                  />
                </svg>
                Refresh
              </>
            )}
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="text-sm font-medium text-gray-500">
              {t("payments.total_revenue")}
            </div>
            <div className="text-2xl font-bold text-green-600">
              {formatCurrency(summary.totalRevenue)}
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="text-sm font-medium text-gray-500">
              {t("payments.total_transactions")}
            </div>
            <div className="text-2xl font-bold text-gray-900">
              {formatNumber(summary.totalTransactions)}
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="text-sm font-medium text-gray-500">
              {t("payments.pending")}
            </div>
            <div className="text-2xl font-bold text-yellow-600">
              {formatCurrency(summary.pendingAmount)}
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="text-sm font-medium text-gray-500">
              {t("payments.refunded")}
            </div>
            <div className="text-2xl font-bold text-gray-400">
              {formatCurrency(summary.refundedAmount)}
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex flex-wrap gap-x-8">
          <button
            onClick={() => setActiveTab("all")}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === "all"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {t("payments.all_payments")}
          </button>
          <button
            onClick={() => setActiveTab("subscriptions")}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === "subscriptions"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {t("payments.subscriptions")}
          </button>
          <button
            onClick={() => setActiveTab("wallet")}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === "wallet"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {t("payments.client_wallets")}
          </button>
        </nav>
      </div>

      {/* Payments Table */}
      {activeTab === "all" && (
        <>
          {/* Filters */}
          <div className="bg-white p-4 rounded-lg shadow mb-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {/* Status Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("payments.status")}
                </label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">{t("common.all")}</option>
                  <option value="pending">
                    {t("payments.status_pending")}
                  </option>
                  <option value="processing">
                    {t("payments.status_processing")}
                  </option>
                  <option value="succeeded">
                    {t("payments.status_succeeded")}
                  </option>
                  <option value="failed">{t("payments.status_failed")}</option>
                  <option value="cancelled">
                    {t("payments.status_cancelled")}
                  </option>
                  <option value="refunded">
                    {t("payments.status_refunded")}
                  </option>
                  <option value="partially_refunded">
                    {t("payments.status_partially_refunded")}
                  </option>
                </select>
              </div>

              {/* Method Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("payments.method")}
                </label>
                <select
                  value={methodFilter}
                  onChange={(e) => setMethodFilter(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">{t("common.all")}</option>
                  <option value="card">
                    {t("payments.payment_methods.card")}
                  </option>
                  <option value="cash">
                    {t("payments.payment_methods.cash")}
                  </option>
                  <option value="bank_transfer">
                    {t("payments.payment_methods.bank_transfer")}
                  </option>
                  <option value="wallet">
                    {t("payments.payment_methods.wallet")}
                  </option>
                </select>
              </div>

              {/* Date From Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("payments.date_from")}
                </label>
                <input
                  type="date"
                  value={dateFromFilter}
                  onChange={(e) => setDateFromFilter(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Date To Filter */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("payments.date_to")}
                </label>
                <input
                  type="date"
                  value={dateToFilter}
                  onChange={(e) => setDateToFilter(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Filter Actions */}
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => {
                  setStatusFilter("");
                  setMethodFilter("");
                  setDateFromFilter("");
                  setDateToFilter("");
                }}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {t("common.clear")}
              </button>
            </div>
          </div>

          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
            <table className="min-w-[720px] w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => handleSort("id")}
                  >
                    <div className="flex items-center">
                      {t("payments.payment_id")}
                      {getSortIcon("id")}
                    </div>
                  </th>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => handleSort("amount")}
                  >
                    <div className="flex items-center">
                      {t("payments.amount")}
                      {getSortIcon("amount")}
                    </div>
                  </th>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => handleSort("status")}
                  >
                    <div className="flex items-center">
                      {t("payments.status")}
                      {getSortIcon("status")}
                    </div>
                  </th>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => handleSort("method")}
                  >
                    <div className="flex items-center">
                      {t("payments.method")}
                      {getSortIcon("method")}
                    </div>
                  </th>
                  <th
                    className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                    onClick={() => handleSort("createdAt")}
                  >
                    <div className="flex items-center">
                      {t("payments.date")}
                      {getSortIcon("createdAt")}
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {payments.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-6 py-4 text-center text-gray-500"
                    >
                      {t("payments.no_payments_found")}
                    </td>
                  </tr>
                ) : (
                  payments.map((payment) => (
                    <tr key={payment.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900">
                        {payment.id.slice(0, 8)}...
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {formatCurrency(payment.amount, payment.currency)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getStatusColor(payment.status)}`}
                        >
                          {payment.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {payment.method}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(payment.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
          </div>

          {/* Pagination Controls */}
          <div className="bg-white px-4 py-3 flex items-center justify-between border-t border-gray-200 sm:px-6">
            <div className="flex-1 flex justify-between sm:hidden">
              <button
                onClick={() => setCurrentPage((prev) => Math.max(prev - 1, 1))}
                disabled={currentPage <= 1}
                className="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("common.previous")}
              </button>
              <button
                onClick={() =>
                  setCurrentPage((prev) => Math.min(prev + 1, totalPages))
                }
                disabled={currentPage >= totalPages}
                className="ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-lg text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("common.next")}
              </button>
            </div>
            <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
              <div>
                <p className="text-sm text-gray-700">
                  {t("payments.showing")}{" "}
                  <span className="font-medium">
                    {(currentPage - 1) * pageSize + 1}
                  </span>{" "}
                  {}
                  {t("payments.to")}{" "}
                  <span className="font-medium">
                    {Math.min(currentPage * pageSize, totalPayments)}
                  </span>{" "}
                  {}
                  {t("payments.of")}{" "}
                  <span className="font-medium">{totalPayments}</span>{" "}
                  {t("payments.results")}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-sm text-gray-700">
                    {t("common.show")}:
                  </label>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setCurrentPage(1); // Reset to first page when changing page size
                    }}
                    className="border border-gray-300 rounded-md text-sm py-1 px-2"
                  >
                    <option value={10}>10</option>
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      setCurrentPage((prev) => Math.max(prev - 1, 1))
                    }
                    disabled={currentPage <= 1}
                    className="px-3 py-1 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t("common.previous")}
                  </button>
                  <span className="text-sm text-gray-700">
                    {currentPage} / {totalPages}
                  </span>
                  <button
                    onClick={() =>
                      setCurrentPage((prev) => Math.min(prev + 1, totalPages))
                    }
                    disabled={currentPage >= totalPages}
                    className="px-3 py-1 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {t("common.next")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Subscriptions Tab */}
      {activeTab === "subscriptions" && <SubscriptionPanel />}

      {/* Wallet Tab */}
      {activeTab === "wallet" && <WalletPanel />}
    </div>
  );
}

// Subscription Panel Component
function SubscriptionPanel() {
  const t = useTranslations();
  const [subscription, setSubscription] = useState<any>(null);
  const [plans, setPlans] = useState<any[]>([]);
  const [usage, setUsage] = useState<any>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  useEffect(() => {
    loadSubscriptionData();
  }, []);

  const loadSubscriptionData = async () => {
    try {
      setLoading(true);
      const [subData, plansData, usageData, invoicesData] = await Promise.all([
        apiClient.getCurrentSubscription(),
        apiClient.getSubscriptionPlans(),
        apiClient.getSubscriptionUsage().catch(() => null),
        apiClient.getSubscriptionInvoices(5).catch(() => []),
      ]);
      setSubscription(subData);
      setPlans(plansData);
      setUsage(usageData);
      setInvoices(invoicesData);
    } catch (error) {
      console.error("Failed to load subscription data:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubscribe = async (planId: string) => {
    try {
      setCheckoutLoading(true);
      const { url } = await apiClient.createSubscriptionCheckout(planId);
      window.location.href = url;
    } catch (error) {
      console.error("Failed to create checkout:", error);
      alert(t("payments.checkout_failed"));
    } finally {
      setCheckoutLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm(t("payments.confirm_cancel_subscription"))) return;
    try {
      await apiClient.cancelSubscription(false);
      loadSubscriptionData();
    } catch (error) {
      console.error("Failed to cancel:", error);
    }
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
      {/* Current Subscription */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">
          {t("payments.current_subscription")}
        </h3>
        {subscription ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-gray-600">{t("payments.plan")}:</span>
              <span className="font-medium capitalize">
                {subscription.plan}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-600">{t("payments.status")}:</span>
              <span
                className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                  subscription.status === "active"
                    ? "bg-green-100 text-green-800"
                    : "bg-yellow-100 text-yellow-800"
                }`}
              >
                {subscription.status}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-600">
                {t("payments.current_period")}:
              </span>
              <span className="text-sm">
                {new Date(subscription.currentPeriodStart).toLocaleDateString()}{" "}
                - {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              </span>
            </div>
            {subscription.cancelAtPeriodEnd && (
              <div className="text-yellow-600 text-sm mt-2">
                {t("payments.subscription_cancel_warning")}
              </div>
            )}
            <button
              onClick={handleCancel}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
            >
              {t("payments.cancel_subscription")}
            </button>
          </div>
        ) : (
          <p className="text-gray-500">
            {t("payments.no_active_subscription")}
          </p>
        )}
      </div>

      {/* Usage Stats */}
      {usage && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">{t("payments.usage")}</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <div className="text-sm text-gray-500">{t("payments.staff")}</div>
              <div className="text-xl font-bold">
                {usage.staffCount} /{" "}
                {usage.limits?.staff || t("payments.unlimited")}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500">
                {t("payments.clients")}
              </div>
              <div className="text-xl font-bold">
                {usage.clientCount} /{" "}
                {usage.limits?.clients || t("payments.unlimited")}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500">
                {t("payments.appointments")}
              </div>
              <div className="text-xl font-bold">
                {usage.appointmentsThisMonth} /{" "}
                {usage.limits?.appointmentsPerMonth || t("payments.unlimited")}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Available Plans */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">
          {t("payments.available_plans")}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {plans.map((plan) => (
            <div key={plan.id} className="border rounded-lg p-4">
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="font-semibold text-lg">{plan.name}</h4>
                  <p className="text-2xl font-bold">
                    €{plan.price}
                    <span className="text-sm font-normal text-gray-500">
                      /{plan.interval}
                    </span>
                  </p>
                </div>
              </div>
              <ul className="mt-4 space-y-2">
                {plan.features?.map((feature: string, idx: number) => (
                  <li
                    key={idx}
                    className="text-sm text-gray-600 flex items-center"
                  >
                    <svg
                      className="w-4 h-4 mr-2 text-green-500"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>
              <button
                onClick={() => handleSubscribe(plan.id)}
                disabled={checkoutLoading || subscription?.plan === plan.name}
                className="mt-4 w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {subscription?.plan === plan.name
                  ? t("payments.current_plan")
                  : t("payments.subscribe")}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Invoices */}
      {invoices.length > 0 && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">
            {t("payments.recent_invoices")}
          </h3>
          <div className="space-y-2">
            {invoices.map((invoice) => (
              <div
                key={invoice.id}
                className="flex items-center justify-between py-2 border-b"
              >
                <div>
                  <div className="font-medium">{invoice.number}</div>
                  <div className="text-sm text-gray-500">
                    {new Date(invoice.date).toLocaleDateString()}
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <span className="font-medium">
                    €{(invoice.amount / 100).toFixed(2)}
                  </span>
                  {invoice.hostedInvoiceUrl && (
                    <a
                      href={invoice.hostedInvoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 text-sm"
                    >
                      View
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Wallet Panel Component
function WalletPanel() {
  const t = useTranslations();
  const [clients, setClients] = useState<any[]>([]);
  const [selectedClient, setSelectedClient] = useState<string | null>(null);
  const [wallet, setWallet] = useState<any>(null);
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    loadClients();
  }, []);

  const loadClients = async () => {
    try {
      setLoading(true);
      const data = await apiClient.getClients();
      setClients(data);
    } catch (error) {
      console.error("Failed to load clients:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadWallet = async (clientId: string) => {
    try {
      setSelectedClient(clientId);
      const walletData = await apiClient.getClientWallet(clientId);
      setWallet(walletData);
      // Would load transactions here too
    } catch (error) {
      console.error("Failed to load wallet:", error);
      // Wallet might not exist yet, that's okay
      setWallet(null);
    }
  };

  const handleDeposit = async (amount: number) => {
    if (!selectedClient) return;
    try {
      setActionLoading(true);
      await (apiClient as any).request(
        `/payments/wallet/${selectedClient}/deposit`,
        {
          method: "POST",
          body: JSON.stringify({ amount: amount * 100 }), // Convert to cents
        },
      );
      loadWallet(selectedClient);
    } catch (error) {
      console.error("Failed to deposit:", error);
      alert(t("payments.deposit_failed"));
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddPoints = async (points: number) => {
    if (!selectedClient) return;
    try {
      setActionLoading(true);
      await (apiClient as any).request(
        `/payments/wallet/${selectedClient}/points/earn`,
        {
          method: "POST",
          body: JSON.stringify({ points }),
        },
      );
      loadWallet(selectedClient);
    } catch (error) {
      console.error("Failed to add points:", error);
      alert(t("payments.add_points_failed"));
    } finally {
      setActionLoading(false);
    }
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
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Client List */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">
            {t("payments.select_client")}
          </h3>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {clients.map((client) => (
              <button
                key={client.id}
                onClick={() => loadWallet(client.id)}
                className={`w-full text-left p-3 rounded-lg transition-colors ${
                  selectedClient === client.id
                    ? "bg-blue-50 border-blue-500 border"
                    : "hover:bg-gray-50 border border-transparent"
                }`}
              >
                <div className="font-medium">
                  {client.firstName} {client.lastName}
                </div>
                <div className="text-sm text-gray-500">{client.email}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Wallet Details */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">
            {t("payments.wallet_details")}
          </h3>
          {selectedClient ? (
            wallet ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                  <span className="text-gray-600">{t("payments.balance")}</span>
                  <span className="text-2xl font-bold text-green-600">
                    €{(wallet.balance / 100).toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                  <span className="text-gray-600">
                    {t("payments.loyalty_points")}
                  </span>
                  <span className="text-2xl font-bold text-blue-600">
                    {wallet.loyaltyPoints}
                  </span>
                </div>

                {/* Quick Actions */}
                <div className="border-t pt-4">
                  <h4 className="font-medium mb-3">
                    {t("payments.quick_actions")}
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => {
                        const amount = prompt(
                          t("payments.enter_deposit_amount"),
                        );
                        if (amount && !isNaN(parseFloat(amount))) {
                          handleDeposit(parseFloat(amount));
                        }
                      }}
                      disabled={actionLoading}
                      className="px-3 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                    >
                      {t("payments.deposit_funds")}
                    </button>
                    <button
                      onClick={() => {
                        const amount = prompt(
                          t("payments.enter_withdraw_amount"),
                        );
                        if (amount && !isNaN(parseFloat(amount))) {
                          handleDeposit(-parseFloat(amount));
                        }
                      }}
                      disabled={actionLoading}
                      className="px-3 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                    >
                      {t("payments.withdraw_funds")}
                    </button>
                    <button
                      onClick={() => {
                        const points = prompt(
                          t("payments.enter_points_to_add"),
                        );
                        if (points && !isNaN(parseInt(points))) {
                          handleAddPoints(parseInt(points));
                        }
                      }}
                      disabled={actionLoading}
                      className="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                    >
                      {t("payments.add_points")}
                    </button>
                    <button
                      onClick={() => {
                        const points = prompt(
                          t("payments.enter_points_to_redeem"),
                        );
                        if (points && !isNaN(parseInt(points))) {
                          (apiClient as any)
                            .request(
                              `/payments/wallet/${selectedClient}/points/redeem`,
                              {
                                method: "POST",
                                body: JSON.stringify({
                                  points: parseInt(points),
                                }),
                              },
                            )
                            .then(() => loadWallet(selectedClient!));
                        }
                      }}
                      disabled={actionLoading}
                      className="px-3 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50"
                    >
                      {t("payments.redeem_points")}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-gray-500 mb-4">
                  {t("payments.no_wallet_found")}
                </p>
                <button
                  onClick={() => loadWallet(selectedClient)}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  {t("payments.create_wallet")}
                </button>
              </div>
            )
          ) : (
            <p className="text-gray-500 text-center py-8">
              {t("payments.select_client_to_view_wallet")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
