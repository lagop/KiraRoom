"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import apiClient, { type CommissionPayout, type CommissionSettings } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { errorMessage, isPlanBlocked } from "@/lib/email-campaigns";
import { saveBlob } from "@/lib/share-download";
import {
  commissionShare,
  defaultPayrollRange,
  formatCommissionCents,
  formatCommissionDay,
  formatPercent,
  lastDayOfPreviousMonth,
  percentFromField,
} from "@/lib/commissions-format";
import {
  TrendingUp,
  CheckCircle,
  Clock,
  AlertCircle,
  Lock,
  Download,
  X,
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
   * "sale": a service or product sold at the till (`kind` says which).
   * "refund_adjustment": commission taken back by a refund given after it was
   * paid ("Ajuste por devolución"), negative, settled by the next payout.
   */
  source?: "appointment" | "sale" | "refund_adjustment";
  kind?: "service" | "product";
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
  /** What this month's payouts paid (undone ones left out). */
  paidCommission: number;
  appointments: CommissionAppointment[];
  /** The salon day the pending figure runs up to: what "Pagar" pays. */
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
    productSales?: number;
    /** Net of the period's refund adjustments. */
    commission: number;
    /** "Ajuste por devolución": the period's refund adjustments (0 or negative). */
    refundAdjustments?: number;
    /** What the period's payouts paid. */
    paid?: number;
  }[];
  /** Walk-in services sold with no professional named: nobody's commission. */
  unassignedServices?: { count: number; totalSales: number };
}

interface Statement {
  professional: { id: string; name: string; isActive: boolean; serviceRate: number; productRate: number };
  period: { start: string; end: string };
  lines: CommissionAppointment[];
  adjustments: CommissionAppointment[];
  payouts: CommissionPayout[];
  totals: { sales: number; earned: number; adjustments: number; net: number; paid: number };
}

type Tab = "summary" | "payroll" | "payouts" | "settings";

const TH = "px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider";
const TH_RIGHT = "px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider";
const TD = "px-6 py-4 whitespace-nowrap text-sm text-gray-900";
const INPUT =
  "w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";
const BUTTON_PRIMARY =
  "bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50";
const BUTTON_SECONDARY =
  "inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50";

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
  const [downloading, setDownloading] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("summary");
  const [selectedProfessional, setSelectedProfessional] = useState<
    string | null
  >(null);
  const [payingCommission, setPayingCommission] = useState(false);
  // "Pagar": the professional, the "Pagar hasta" day and the figure up to it.
  const [pendingPay, setPendingPay] = useState<CommissionSummary | null>(null);
  const [payToday, setPayToday] = useState("");
  const [payUpTo, setPayUpTo] = useState("");
  const [payPreview, setPayPreview] = useState<CommissionSummary | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // "Pagos".
  const [payouts, setPayouts] = useState<CommissionPayout[] | null>(null);
  const [payoutsLoading, setPayoutsLoading] = useState(false);
  const [payoutsError, setPayoutsError] = useState<string | null>(null);
  const [pendingUndo, setPendingUndo] = useState<CommissionPayout | null>(null);
  const [undoing, setUndoing] = useState(false);
  // "Ver extracto".
  const [statement, setStatement] = useState<Statement | null>(null);
  const [statementFor, setStatementFor] = useState<string | null>(null);
  const [statementError, setStatementError] = useState<string | null>(null);
  // "Ajustes".
  const [settings, setSettings] = useState<CommissionSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState({ defaultRate: "", productDefaultRate: "", base: "net" as "net" | "gross" });
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
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

  const downloadCsv = async () => {
    try {
      setDownloading(true);
      const { blob, filename } = await apiClient.downloadPayrollCsv(dateRange.startDate, dateRange.endDate);
      saveBlob(blob, filename);
    } catch (error) {
      toast({ title: t("commissions.csv_error"), description: errorMessage(error, ""), variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  const loadPayouts = async () => {
    try {
      setPayoutsLoading(true);
      setPayoutsError(null);
      setPayouts(await apiClient.getCommissionPayouts());
    } catch (error) {
      setPayoutsError(errorMessage(error, t("commissions.payouts_error")));
    } finally {
      setPayoutsLoading(false);
    }
  };

  const loadSettings = async () => {
    try {
      setSettingsError(null);
      const data = await apiClient.getCommissionSettings();
      setSettings(data);
      setSettingsForm({
        defaultRate: String(data.defaultRate),
        productDefaultRate: String(data.productDefaultRate),
        base: data.base,
      });
    } catch (error) {
      setSettingsError(errorMessage(error, t("commissions.settings_load_error")));
    }
  };

  const openTab = (tab: Tab) => {
    setActiveTab(tab);
    if (tab === "payroll" && !payrollReport && !reportLoading) loadPayrollReport();
    if (tab === "payouts" && !payouts && !payoutsLoading) loadPayouts();
    if (tab === "settings" && !settings) loadSettings();
  };

  // ---- "Pagar" ----------------------------------------------------------

  const openPay = (commission: CommissionSummary) => {
    const today = commission.pendingUpTo ?? "";
    setPendingPay(commission);
    setPayToday(today);
    setPayUpTo(today);
    setPayPreview(commission);
    setPreviewError(null);
  };

  const closePay = () => {
    setPendingPay(null);
    setPayPreview(null);
  };

  // "Pagar hasta": the summary re-read up to that day; what is paid is what it shows.
  const changePayUpTo = async (day: string) => {
    if (!pendingPay || !day) return;
    setPayUpTo(day);
    try {
      setPreviewLoading(true);
      setPreviewError(null);
      setPayPreview(await apiClient.getCommissionSummary(pendingPay.professionalId, day));
    } catch (error) {
      setPayPreview(null);
      setPreviewError(errorMessage(error, t("commissions.pay_preview_error")));
    } finally {
      setPreviewLoading(false);
    }
  };

  const performPayCommission = async () => {
    if (!pendingPay) return;
    if (!payPreview || payPreview.appointments.length === 0) {
      toast({ title: t("commissions.pay_nothing") });
      closePay();
      return;
    }
    try {
      setPayingCommission(true);
      // Up to the day chosen, the figure the dialog showed. If that figure
      // changed meanwhile, the server pays nothing and says so (409).
      await apiClient.payCommission(pendingPay.professionalId, {
        endDate: payUpTo,
        expectedAmount: payPreview.pendingCommission,
      });
      toast({ title: t("commissions.commissions_paid_success") });
    } catch (error) {
      toast({
        title: t("commissions.failed_to_pay_commissions"),
        description: error instanceof Error && error.message ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPayingCommission(false);
      closePay();
      setPayouts(null);
      await loadCommissions();
    }
  };

  // ---- "Deshacer último pago" ------------------------------------------

  const performUndo = async () => {
    if (!pendingUndo) return;
    try {
      setUndoing(true);
      await apiClient.undoCommissionPayout(pendingUndo.id);
      toast({ title: t("commissions.undo_success") });
    } catch (error) {
      toast({ title: t("commissions.undo_error"), description: errorMessage(error, ""), variant: "destructive" });
    } finally {
      setUndoing(false);
      setPendingUndo(null);
      await Promise.all([loadPayouts(), loadCommissions()]);
    }
  };

  // ---- "Ver extracto" ---------------------------------------------------

  const openStatement = async (professionalId: string) => {
    if (!payrollReport) return;
    setStatementFor(professionalId);
    setStatement(null);
    setStatementError(null);
    try {
      setStatement(
        await apiClient.getCommissionStatement(
          professionalId,
          payrollReport.period.start,
          payrollReport.period.end,
        ),
      );
    } catch (error) {
      setStatementError(errorMessage(error, t("commissions.statement_error")));
    }
  };

  // ---- "Ajustes" --------------------------------------------------------

  const defaultRateValue = percentFromField(settingsForm.defaultRate);
  const productRateValue = percentFromField(settingsForm.productDefaultRate);
  const settingsInvalid = defaultRateValue === null || productRateValue === null;

  const saveSettings = async () => {
    if (settingsInvalid) return;
    try {
      setSavingSettings(true);
      const saved = await apiClient.updateCommissionSettings({
        defaultRate: defaultRateValue,
        productDefaultRate: productRateValue,
        base: settingsForm.base,
      });
      setSettings(saved);
      toast({ title: t("commissions.settings_saved") });
      await loadCommissions();
    } catch (error) {
      toast({ title: t("commissions.settings_error"), description: errorMessage(error, ""), variant: "destructive" });
    } finally {
      setSavingSettings(false);
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

  const entryName = (apt: CommissionAppointment) =>
    apt.source === "refund_adjustment"
      ? `${t("commissions.refund_adjustment")}${apt.description ? `: ${apt.description}` : ""}`
      : apt.kind === "product"
        ? `${t("commissions.product")}: ${apt.serviceName}`
        : apt.serviceName;

  const inactiveBadge = (
    <span className="ml-2 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 align-middle text-xs font-medium text-gray-600">
      {t("commissions.inactive")}
    </span>
  );

  const statusBadge = (paid: boolean) =>
    paid ? (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
        <CheckCircle className="w-3 h-3 mr-1" /> {t("commissions.paid")}
      </span>
    ) : (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
        <Clock className="w-3 h-3 mr-1" /> {t("commissions.pending")}
      </span>
    );

  const tabButton = (tab: Tab, label: string) => (
    <button
      onClick={() => openTab(tab)}
      className={`py-4 px-1 border-b-2 font-medium text-sm ${
        activeTab === tab
          ? "border-blue-500 text-blue-600"
          : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
      }`}
    >
      {label}
    </button>
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

  const nothingToPay = !payPreview || payPreview.appointments.length === 0;

  return (
    <div className="space-y-6">
      {header}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">
                {t("commissions.paid_this_month")}
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
          {tabButton("summary", t("commissions.commission_summary"))}
          {tabButton("payroll", t("commissions.payroll_report"))}
          {tabButton("payouts", t("commissions.tab_payouts"))}
          {tabButton("settings", t("commissions.tab_settings"))}
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
              <button onClick={loadCommissions} className={BUTTON_PRIMARY}>
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
                        {t("commissions.paid_this_month")}:{" "}
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
                          onClick={() => openPay(commission)}
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
                          <th className={TH}>{t("commissions.date")}</th>
                          <th className={TH}>{t("commissions.client")}</th>
                          <th className={TH}>{t("commissions.service")}</th>
                          <th className={TH_RIGHT}>{t("commissions.amount")}</th>
                          <th className={TH_RIGHT}>{t("commissions.rate")}</th>
                          <th className={TH_RIGHT}>{t("commissions.commission")}</th>
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
                              <td className={TD}>{formatDate(apt.date)}</td>
                              <td className={TD}>{apt.clientName}</td>
                              <td className={TD}>{entryName(apt)}</td>
                              <td className={`${TD} text-right`}>
                                {adjustment ? "—" : formatCurrency(apt.amount)}
                              </td>
                              <td className={`${TD} text-right`}>
                                {adjustment ? "—" : formatPercent(apt.commissionRate)}
                              </td>
                              <td className={`${TD} font-medium text-right`}>
                                {formatCurrency(apt.commissionAmount)}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-center">{statusBadge(apt.paid)}</td>
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
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("commissions.start_date")}
                </label>
                <input
                  type="date"
                  value={dateRange.startDate}
                  onChange={(e) => setDateRange({ ...dateRange, startDate: e.target.value })}
                  className={INPUT}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("commissions.end_date")}
                </label>
                <input
                  type="date"
                  value={dateRange.endDate}
                  onChange={(e) => setDateRange({ ...dateRange, endDate: e.target.value })}
                  className={INPUT}
                />
              </div>
              <button onClick={loadPayrollReport} disabled={reportLoading} className={BUTTON_PRIMARY}>
                {reportLoading ? t("commissions.generating") : t("commissions.generate_report")}
              </button>
              <button onClick={downloadCsv} disabled={downloading} className={BUTTON_SECONDARY}>
                <Download className="h-4 w-4" />
                {t("commissions.download_csv")}
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
              <button onClick={loadPayrollReport} className={BUTTON_PRIMARY}>
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
                  <table className="min-w-[900px] w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className={TH}>{t("commissions.professional")}</th>
                        <th className={TH_RIGHT}>{t("commissions.total_sales")}</th>
                        <th className={TH_RIGHT}>{t("commissions.refund_adjustment")}</th>
                        <th className={TH_RIGHT}>{t("commissions.commission")}</th>
                        <th className={TH_RIGHT}>{t("commissions.paid_in_period")}</th>
                        <th className={TH_RIGHT}>{t("commissions.percentage_of_sales")}</th>
                        <th className={TH_RIGHT}>
                          <span className="sr-only">{t("commissions.view_statement")}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {payrollReport.professionals.map((prof) => (
                        <tr key={prof.id} className="hover:bg-gray-50">
                          <td className={`${TD} font-medium`}>
                            {prof.name}
                            {prof.isActive === false && inactiveBadge}
                          </td>
                          <td className={`${TD} text-right`}>{formatCurrency(prof.totalSales)}</td>
                          <td className={`${TD} text-right`}>
                            {prof.refundAdjustments ? formatCurrency(prof.refundAdjustments) : "—"}
                          </td>
                          <td className={`${TD} font-medium text-right`}>{formatCurrency(prof.commission)}</td>
                          <td className={`${TD} text-right`}>{prof.paid ? formatCurrency(prof.paid) : "—"}</td>
                          <td className={`${TD} text-right`}>{commissionShare(prof.commission, prof.totalSales)}</td>
                          <td className={`${TD} text-right`}>
                            <button
                              onClick={() => openStatement(prof.id)}
                              className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                            >
                              {t("commissions.view_statement")}
                            </button>
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
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-amber-900 text-right">—</td>
                          <td className="px-6 py-4" />
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

      {/* Payouts Tab */}
      {activeTab === "payouts" && (
        <div className="space-y-4">
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-lg font-semibold text-gray-900">{t("commissions.payouts_title")}</h3>
            <p className="text-sm text-gray-500">{t("commissions.payouts_hint")}</p>
          </div>
          {payoutsLoading && (
            <div className="flex items-center justify-center h-32" aria-busy="true">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          )}
          {!payoutsLoading && payoutsError && (
            <div role="alert" className="bg-white rounded-lg shadow p-6 text-center">
              <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-2" />
              <p className="font-medium text-gray-900">{t("commissions.payouts_error")}</p>
              <p className="text-sm text-gray-500 mb-4">{payoutsError}</p>
              <button onClick={loadPayouts} className={BUTTON_PRIMARY}>
                {t("commissions.retry")}
              </button>
            </div>
          )}
          {!payoutsLoading && !payoutsError && payouts && payouts.length === 0 && (
            <div className="bg-white rounded-lg shadow p-12 text-center text-gray-500">
              {t("commissions.payouts_empty")}
            </div>
          )}
          {!payoutsLoading && !payoutsError && payouts && payouts.length > 0 && (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-[860px] w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className={TH}>{t("commissions.payout_date")}</th>
                      <th className={TH}>{t("commissions.professional")}</th>
                      <th className={TH}>{t("commissions.payout_up_to")}</th>
                      <th className={TH_RIGHT}>{t("commissions.amount")}</th>
                      <th className={TH_RIGHT}>{t("commissions.payout_items")}</th>
                      <th className={TH}>{t("commissions.payout_by")}</th>
                      <th className={TH}>{t("commissions.status")}</th>
                      <th className={TH_RIGHT}>
                        <span className="sr-only">{t("commissions.undo_last")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {payouts.map((p) => (
                      <tr key={p.id} className={p.undoneAt ? "bg-gray-50 text-gray-500" : "hover:bg-gray-50"}>
                        <td className={TD}>{formatDate(p.createdAt)}</td>
                        <td className={TD}>{p.professionalName}</td>
                        <td className={TD}>{formatDate(p.upTo)}</td>
                        <td className={`${TD} text-right font-medium`}>{formatCurrency(p.amountCents)}</td>
                        <td className={`${TD} text-right`}>{p.itemCount}</td>
                        <td className={TD}>{p.createdByName ?? "—"}</td>
                        <td className={TD}>
                          {p.undoneAt ? (
                            <span className="text-xs text-gray-600">
                              {p.undoneByName
                                ? t("commissions.payout_undone_by", { name: p.undoneByName })
                                : t("commissions.payout_undone")}
                            </span>
                          ) : (
                            statusBadge(true)
                          )}
                        </td>
                        <td className={`${TD} text-right`}>
                          {p.canUndo && !p.undoneAt && (
                            <button
                              onClick={() => setPendingUndo(p)}
                              disabled={undoing}
                              className="text-red-600 hover:text-red-800 text-sm font-medium disabled:opacity-50"
                            >
                              {t("commissions.undo_last")}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Settings Tab */}
      {activeTab === "settings" && (
        <div className="bg-white rounded-lg shadow p-6 space-y-5 max-w-2xl">
          <h3 className="text-lg font-semibold text-gray-900">{t("commissions.settings_title")}</h3>
          {settingsError ? (
            <div role="alert" className="text-sm text-red-700">
              {settingsError}{" "}
              <button onClick={loadSettings} className="font-medium underline">
                {t("commissions.retry")}
              </button>
            </div>
          ) : !settings ? (
            <div className="flex items-center justify-center h-24" aria-busy="true">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="commission-default-rate" className="block text-sm font-medium text-gray-700 mb-1">
                  {t("commissions.default_rate")}
                </label>
                <input
                  id="commission-default-rate"
                  inputMode="decimal"
                  value={settingsForm.defaultRate}
                  onChange={(e) => setSettingsForm({ ...settingsForm, defaultRate: e.target.value })}
                  className={`${INPUT} sm:max-w-[10rem]`}
                  aria-invalid={defaultRateValue === null}
                />
                <p className="mt-1 text-xs text-gray-500">{t("commissions.default_rate_hint")}</p>
                {defaultRateValue === null && (
                  <p className="mt-1 text-xs text-red-600">{t("commissions.invalid_percent")}</p>
                )}
              </div>
              <div>
                <label htmlFor="commission-product-rate" className="block text-sm font-medium text-gray-700 mb-1">
                  {t("commissions.product_default_rate")}
                </label>
                <input
                  id="commission-product-rate"
                  inputMode="decimal"
                  value={settingsForm.productDefaultRate}
                  onChange={(e) => setSettingsForm({ ...settingsForm, productDefaultRate: e.target.value })}
                  className={`${INPUT} sm:max-w-[10rem]`}
                  aria-invalid={productRateValue === null}
                />
                <p className="mt-1 text-xs text-gray-500">{t("commissions.product_default_rate_hint")}</p>
                {productRateValue === null && (
                  <p className="mt-1 text-xs text-red-600">{t("commissions.invalid_percent")}</p>
                )}
              </div>
              <fieldset>
                <legend className="block text-sm font-medium text-gray-700 mb-1">{t("commissions.base_label")}</legend>
                <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                  {(["net", "gross"] as const).map((base) => (
                    <label key={base} className="inline-flex items-center gap-2 text-sm text-gray-800">
                      <input
                        type="radio"
                        name="commission-base"
                        checked={settingsForm.base === base}
                        onChange={() => setSettingsForm({ ...settingsForm, base })}
                      />
                      {base === "net" ? t("commissions.base_net") : t("commissions.base_gross")}
                    </label>
                  ))}
                </div>
                <p className="mt-1 text-xs text-gray-500">{t("commissions.base_hint")}</p>
              </fieldset>
              <button onClick={saveSettings} disabled={savingSettings || settingsInvalid} className={BUTTON_PRIMARY}>
                {savingSettings ? t("commissions.saving") : t("commissions.save")}
              </button>
            </>
          )}
        </div>
      )}

      {/* "Ver extracto" */}
      {statementFor && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="commission-statement-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setStatementFor(null);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 id="commission-statement-title" className="text-base font-semibold text-gray-900">
                  {t("commissions.statement_title", { name: statement?.professional.name ?? "" })}
                </h2>
                {statement && (
                  <p className="text-sm text-gray-500">
                    {formatDate(statement.period.start)} - {formatDate(statement.period.end)}
                    {" • "}
                    {t("commissions.statement_rates", {
                      service: formatPercent(statement.professional.serviceRate),
                      product: formatPercent(statement.professional.productRate),
                    })}
                  </p>
                )}
              </div>
              <button
                onClick={() => setStatementFor(null)}
                aria-label={t("commissions.close")}
                className="rounded p-1 text-gray-500 hover:bg-gray-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {statementError ? (
              <p role="alert" className="text-sm text-red-700">{statementError}</p>
            ) : !statement ? (
              <div className="flex items-center justify-center h-24" aria-busy="true">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
              </div>
            ) : (
              <div className="space-y-5 text-sm">
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {(
                    [
                      ["statement_sales", statement.totals.sales],
                      ["statement_earned", statement.totals.earned],
                      ["statement_adjustments", statement.totals.adjustments],
                      ["statement_net", statement.totals.net],
                      ["statement_paid", statement.totals.paid],
                    ] as const
                  ).map(([key, value]) => (
                    <div key={key} className="rounded-md bg-gray-50 p-3">
                      <dt className="text-xs text-gray-500">{t(`commissions.${key}`)}</dt>
                      <dd className="font-semibold text-gray-900">{formatCurrency(value)}</dd>
                    </div>
                  ))}
                </dl>
                {statement.lines.length === 0 && statement.adjustments.length === 0 && statement.payouts.length === 0 ? (
                  <p className="text-gray-500">{t("commissions.statement_empty")}</p>
                ) : (
                  <>
                    {statement.lines.length > 0 && (
                      <section>
                        <h3 className="mb-2 font-medium text-gray-900">{t("commissions.statement_lines")}</h3>
                        <ul className="divide-y divide-gray-100">
                          {statement.lines.map((l) => (
                            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                              <span className="min-w-0">
                                {formatDate(l.date)} · {l.clientName} · {entryName(l)}
                              </span>
                              <span className="flex items-center gap-3 whitespace-nowrap">
                                <span className="text-gray-500">
                                  {formatCurrency(l.amount)} × {formatPercent(l.commissionRate)}
                                </span>
                                <span className="font-medium">{formatCurrency(l.commissionAmount)}</span>
                                {statusBadge(l.paid)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {statement.adjustments.length > 0 && (
                      <section>
                        <h3 className="mb-2 font-medium text-gray-900">{t("commissions.statement_adjustments")}</h3>
                        <ul className="divide-y divide-gray-100">
                          {statement.adjustments.map((a) => (
                            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                              <span className="min-w-0">
                                {formatDate(a.date)} · {entryName(a)}
                              </span>
                              <span className="flex items-center gap-3 whitespace-nowrap">
                                <span className="font-medium">{formatCurrency(a.commissionAmount)}</span>
                                {statusBadge(a.paid)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                    {statement.payouts.length > 0 && (
                      <section>
                        <h3 className="mb-2 font-medium text-gray-900">{t("commissions.statement_payouts")}</h3>
                        <ul className="divide-y divide-gray-100">
                          {statement.payouts.map((p) => (
                            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                              <span>
                                {formatDate(p.createdAt)} · {t("commissions.payout_up_to")} {formatDate(p.upTo)} ·{" "}
                                {itemsLabel(p.itemCount)}
                              </span>
                              <span className="font-medium">{formatCurrency(p.amountCents)}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingPay}
        title={t("commissions.confirm_mark_all_paid")}
        description={
          pendingPay && (
            <div className="space-y-3">
              <div>
                <label htmlFor="commission-pay-up-to" className="block text-sm font-medium text-gray-700 mb-1">
                  {t("commissions.pay_up_to")}
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    id="commission-pay-up-to"
                    type="date"
                    value={payUpTo}
                    max={payToday || undefined}
                    onChange={(e) => changePayUpTo(e.target.value)}
                    className="border border-gray-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => changePayUpTo(payToday)}
                    className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {t("commissions.today")}
                  </button>
                  <button
                    type="button"
                    onClick={() => changePayUpTo(lastDayOfPreviousMonth(payToday))}
                    className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {t("commissions.end_of_last_month")}
                  </button>
                </div>
              </div>
              {previewLoading ? (
                <p aria-busy="true">{t("commissions.pay_preview_loading")}</p>
              ) : previewError ? (
                <p role="alert" className="text-red-700">{previewError}</p>
              ) : nothingToPay ? (
                <p>{t("commissions.pay_nothing")}</p>
              ) : (
                <p>
                  {t("commissions.confirm_mark_paid_description_until", {
                    name: pendingPay.professionalName,
                    amount: formatCurrency(payPreview!.pendingCommission),
                    date: formatDate(payUpTo),
                  })}
                </p>
              )}
            </div>
          )
        }
        confirmLabel={t("commissions.mark_paid")}
        loading={payingCommission || previewLoading}
        onCancel={closePay}
        onConfirm={performPayCommission}
      />

      <ConfirmDialog
        open={!!pendingUndo}
        title={t("commissions.undo_confirm_title")}
        description={
          pendingUndo &&
          t("commissions.undo_confirm_description", {
            name: pendingUndo.professionalName,
            amount: formatCurrency(pendingUndo.amountCents),
          })
        }
        confirmLabel={t("commissions.undo_confirm")}
        destructive
        loading={undoing}
        onCancel={() => setPendingUndo(null)}
        onConfirm={performUndo}
      />
    </div>
  );
}
