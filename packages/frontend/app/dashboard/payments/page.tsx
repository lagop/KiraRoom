"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import apiClient, {
  ClientLoyaltySummary,
  type Client,
  type Payment,
  type PaymentFilters,
  type PaymentSummary,
  type WalletTopUpMethod,
} from "@/lib/api";
import { WALLET_TOP_UP_METHODS, topUpProblem } from "@/lib/cash-session";
import { useTranslations } from "@/lib/use-translation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { getCurrentUser } from "@/lib/utils";
import { isManager } from "@/lib/dashboard-nav";
import { RefundPaymentDialog } from "@/components/payments/RefundPaymentDialog";
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  formatEuros,
  methodLabel,
  parseEurosToCents,
  paymentConcept,
  refundableCents,
  statusLabel,
} from "@/lib/payments-format";

const SORTABLE = ["createdAt", "amount", "status", "method"] as const;
type SortField = (typeof SORTABLE)[number];

/** The methods a salon charges with at the till (the filter's options). */
const FILTER_METHODS = ["cash", "card", "bank_transfer", "wallet"] as const;

function statusColor(status: string, partlyRefunded: boolean): string {
  if (status === "paid") return partlyRefunded ? "bg-amber-100 text-amber-800" : "bg-green-100 text-green-800";
  if (status === "pending") return "bg-yellow-100 text-yellow-800";
  if (status === "failed") return "bg-red-100 text-red-800";
  return "bg-gray-100 text-gray-800";
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PaymentsPage() {
  const t = useTranslations();
  const { toast } = useToast();

  // Read after mount (the server has no token): until then nobody counts as
  // a manager, so manager-only controls appear once the role is known.
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, []);
  const manager = isManager(role);

  const [payments, setPayments] = useState<Payment[]>([]);
  const [summary, setSummary] = useState<PaymentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"all" | "wallet">("all");

  // Filters: sent to the server (list, cards and CSV alike).
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [methodFilter, setMethodFilter] = useState<string>("");
  const [dateFromFilter, setDateFromFilter] = useState<string>("");
  const [dateToFilter, setDateToFilter] = useState<string>("");

  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(20);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [totalPayments, setTotalPayments] = useState<number>(0);

  const [sortBy, setSortBy] = useState<SortField>("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const [refunding, setRefunding] = useState<Payment | null>(null);
  const [exporting, setExporting] = useState(false);

  const filters = useCallback(
    (): PaymentFilters => ({
      status: (statusFilter || undefined) as PaymentFilters["status"],
      method: (methodFilter || undefined) as PaymentFilters["method"],
      dateFrom: dateFromFilter || undefined,
      dateTo: dateToFilter || undefined,
    }),
    [statusFilter, methodFilter, dateFromFilter, dateToFilter],
  );

  const loadPayments = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [page, cards] = await Promise.all([
        apiClient.getPayments({ ...filters(), page: currentPage, limit: pageSize, sortBy, sortOrder }),
        // The cards are for owner and admin.
        manager ? apiClient.getPaymentSummary(filters()).catch(() => null) : Promise.resolve(null),
      ]);
      setPayments(page.payments ?? []);
      setTotalPages(Math.max(1, page.pagination?.totalPages ?? 1));
      setTotalPayments(page.pagination?.total ?? 0);
      setSummary(cards);
    } catch (error) {
      setPayments([]);
      setSummary(null);
      setTotalPages(1);
      setTotalPayments(0);
      setLoadError(error instanceof Error ? error.message : "No se han podido cargar los pagos.");
    } finally {
      setLoading(false);
    }
  }, [filters, currentPage, pageSize, sortBy, sortOrder, manager]);

  useEffect(() => {
    if (activeTab === "all") void loadPayments();
  }, [loadPayments, activeTab]);

  // A filter change goes back to the first page.
  const setFilter = (set: (v: string) => void) => (value: string) => {
    set(value);
    setCurrentPage(1);
  };

  const handleSort = (column: SortField) => {
    if (sortBy === column) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortOrder(column === "createdAt" || column === "amount" ? "desc" : "asc");
    }
    setCurrentPage(1);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await apiClient.downloadPaymentsCsv(filters());
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        title: "No se ha podido exportar",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const sortIcon = (column: SortField) => {
    if (sortBy !== column) return <span className="ml-1 text-gray-300">↕</span>;
    return <span className="ml-1 text-blue-600">{sortOrder === "asc" ? "↑" : "↓"}</span>;
  };

  const header = (label: string, column?: SortField) => (
    <th
      className={`px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 ${
        column ? "cursor-pointer select-none hover:bg-gray-100" : ""
      }`}
      onClick={column ? () => handleSort(column) : undefined}
    >
      <span className="inline-flex items-center">
        {label}
        {column && sortIcon(column)}
      </span>
    </th>
  );

  const anyFilter = !!(statusFilter || methodFilter || dateFromFilter || dateToFilter);
  const columns = manager ? 7 : 6;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="truncate text-2xl font-bold text-gray-900">{t("payments.title")}</h1>
          <p className="text-gray-600">{t("payments.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {manager && activeTab === "all" && (
            <button
              onClick={exportCsv}
              disabled={exporting}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {exporting ? "Exportando…" : "Exportar CSV"}
            </button>
          )}
          {activeTab === "all" && (
            <button
              onClick={() => void loadPayments()}
              disabled={loading}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
            >
              {loading ? "Cargando…" : "Actualizar"}
            </button>
          )}
        </div>
      </div>

      {/* Summary cards (owner/admin), for the filters below */}
      {manager && summary && activeTab === "all" && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg bg-white p-6 shadow">
              <div className="text-sm font-medium text-gray-500">{t("payments.total_revenue")}</div>
              <div className="text-2xl font-bold text-green-600">{formatEuros(summary.totalRevenue)}</div>
              <div className="mt-1 text-xs text-gray-500">Cobrado, descontadas las devoluciones</div>
            </div>
            <div className="rounded-lg bg-white p-6 shadow">
              <div className="text-sm font-medium text-gray-500">{t("payments.total_transactions")}</div>
              <div className="text-2xl font-bold text-gray-900">{summary.totalTransactions}</div>
            </div>
            <div className="rounded-lg bg-white p-6 shadow">
              <div className="text-sm font-medium text-gray-500">{t("payments.pending")}</div>
              <div className="text-2xl font-bold text-yellow-600">{formatEuros(summary.pendingAmount)}</div>
            </div>
            <div className="rounded-lg bg-white p-6 shadow">
              <div className="text-sm font-medium text-gray-500">{t("payments.refunded")}</div>
              <div className="text-2xl font-bold text-gray-500">{formatEuros(summary.refundedAmount)}</div>
            </div>
          </div>
          {summary.byMethod.length > 0 && (
            <div className="flex flex-wrap gap-2 text-sm">
              {summary.byMethod.map((m) => (
                <span key={m.method} className="rounded-full bg-white px-3 py-1 text-gray-700 shadow-sm">
                  {methodLabel(m.method)}: <strong>{formatEuros(m.amount)}</strong>{" "}
                  <span className="text-gray-500">
                    ({m.count} {m.count === 1 ? "cobro" : "cobros"})
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex flex-col gap-2 border-b border-gray-200 sm:flex-row sm:items-end sm:justify-between">
        <nav className="-mb-px flex flex-wrap gap-x-8">
          {(
            [
              ["all", t("payments.all_payments")],
              ["wallet", t("payments.client_wallets")],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`border-b-2 px-1 py-4 text-sm font-medium ${
                activeTab === key
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
        {manager && (
          // KiraRoom's own plan is managed in Suscripción, not here.
          <Link href="/dashboard/billing" className="pb-3 text-sm text-blue-600 hover:underline">
            Tu suscripción a KiraRoom →
          </Link>
        )}
      </div>

      {activeTab === "all" && (
        <>
          {/* Filters */}
          <div className="mb-4 rounded-lg bg-white p-4 shadow">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-gray-700">{t("payments.status")}</span>
                <select
                  value={statusFilter}
                  onChange={(e) => setFilter(setStatusFilter)(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">{t("common.all")}</option>
                  {Object.entries(PAYMENT_STATUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-gray-700">{t("payments.method")}</span>
                <select
                  value={methodFilter}
                  onChange={(e) => setFilter(setMethodFilter)(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">{t("common.all")}</option>
                  {FILTER_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-gray-700">{t("payments.date_from")}</span>
                <input
                  type="date"
                  value={dateFromFilter}
                  max={dateToFilter || undefined}
                  onChange={(e) => setFilter(setDateFromFilter)(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-gray-700">{t("payments.date_to")}</span>
                <input
                  type="date"
                  value={dateToFilter}
                  min={dateFromFilter || undefined}
                  onChange={(e) => setFilter(setDateToFilter)(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </label>
            </div>
            {anyFilter && (
              <div className="mt-4">
                <button
                  onClick={() => {
                    setStatusFilter("");
                    setMethodFilter("");
                    setDateFromFilter("");
                    setDateToFilter("");
                    setCurrentPage(1);
                  }}
                  className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  {t("common.clear")}
                </button>
              </div>
            )}
          </div>

          {loadError && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {loadError}
            </div>
          )}

          <div className="overflow-hidden rounded-lg bg-white shadow">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    {header(t("payments.date"), "createdAt")}
                    {header("Clienta")}
                    {header("Concepto")}
                    {header(t("payments.amount"), "amount")}
                    {header(t("payments.method"), "method")}
                    {header(t("payments.status"), "status")}
                    {manager && header("")}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {loading ? (
                    <tr>
                      <td colSpan={columns} className="px-4 py-8 text-center text-gray-500">
                        Cargando…
                      </td>
                    </tr>
                  ) : payments.length === 0 ? (
                    <tr>
                      <td colSpan={columns} className="px-4 py-8 text-center text-gray-500">
                        {loadError ? "—" : t("payments.no_payments_found")}
                      </td>
                    </tr>
                  ) : (
                    payments.map((payment) => {
                      const refunded = payment.refundedAmount ?? 0;
                      const partly = payment.status === "paid" && refunded > 0;
                      const canRefund = manager && refundableCents(payment) > 0;
                      return (
                        <tr key={payment.id} className="hover:bg-gray-50">
                          <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                            {formatDateTime(payment.createdAt)}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900">
                            {payment.client
                              ? `${payment.client.firstName} ${payment.client.lastName}`.trim()
                              : "—"}
                          </td>
                          <td className="max-w-xs truncate px-4 py-3 text-sm text-gray-600" title={paymentConcept(payment)}>
                            {paymentConcept(payment)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">
                            {formatEuros(payment.amount)}
                            {refunded > 0 && (
                              <div className="text-xs font-normal text-gray-500">−{formatEuros(refunded)} devuelto</div>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-600">
                            {methodLabel(payment.method)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3">
                            <span
                              className={`inline-flex rounded-full px-2 text-xs font-semibold leading-5 ${statusColor(payment.status, partly)}`}
                            >
                              {partly ? "Pagado · devuelto en parte" : statusLabel(payment.status)}
                            </span>
                          </td>
                          {manager && (
                            <td className="whitespace-nowrap px-4 py-3 text-right">
                              {canRefund && (
                                <button
                                  onClick={() => setRefunding(payment)}
                                  className="text-sm text-red-600 hover:text-red-800"
                                >
                                  Reembolsar
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          <div className="flex flex-col gap-3 border-t border-gray-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="text-sm text-gray-700">
              {totalPayments === 0 ? (
                <>0 {t("payments.results")}</>
              ) : (
                <>
                  {t("payments.showing")} <span className="font-medium">{(currentPage - 1) * pageSize + 1}</span>{" "}
                  {t("payments.to")}{" "}
                  <span className="font-medium">{Math.min(currentPage * pageSize, totalPayments)}</span>{" "}
                  {t("payments.of")} <span className="font-medium">{totalPayments}</span> {t("payments.results")}
                </>
              )}
            </p>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                {t("common.show")}:
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                >
                  {[10, 20, 50, 100].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
                  disabled={currentPage <= 1}
                  className="rounded-md border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("common.previous")}
                </button>
                <span className="text-sm text-gray-700">
                  {currentPage} / {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
                  disabled={currentPage >= totalPages}
                  className="rounded-md border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("common.next")}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {activeTab === "wallet" && <WalletPanel manager={manager} />}

      <RefundPaymentDialog
        payment={refunding}
        onClose={() => setRefunding(null)}
        onRefunded={() => void loadPayments()}
      />
    </div>
  );
}

interface WalletView {
  balance: number;
  transactions?: {
    id: string;
    type: "credit" | "debit";
    amount: number;
    balanceAfter: number;
    description?: string | null;
    /** How a top-up was paid; null for other movements. */
    method?: string | null;
    createdAt: string;
  }[];
}

/**
 * A client's wallet (money she left at the salon). Clients are found with
 * the server's search; a client with no wallet yet shows 0 € and
 * "Ingresar", whose first deposit creates it.
 */
function WalletPanel({ manager }: { manager: boolean }) {
  const t = useTranslations();
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Client | null>(null);
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  // Points live in the loyalty ledger (Fidelización), not in the wallet:
  // ClientWallet.loyaltyPoints stopped moving in #120 and showed 0 here.
  const [loyalty, setLoyalty] = useState<ClientLoyaltySummary | null>(null);
  const selectedRef = useRef<string | null>(null);

  const [movement, setMovement] = useState<"deposit" | "withdraw" | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [movementError, setMovementError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A top-up says how she pays it; cash goes into the till's drawer, so it needs one open.
  const [topUpMethod, setTopUpMethod] = useState<WalletTopUpMethod | null>(null);
  const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null);

  // Server-side search, a moment after typing stops.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const page = await apiClient.getClientsPage({ page: 1, pageSize: 25, q: query, sort: "firstName", dir: "asc" });
        if (!cancelled) setClients(page.data ?? []);
      } catch {
        if (!cancelled) setClients([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const loadWallet = async (client: Client) => {
    setSelected(client);
    selectedRef.current = client.id;
    setLoyalty(null);
    setWalletLoading(true);
    apiClient
      .getClientLoyalty(client.id)
      // A late answer for a client no longer selected must not show here.
      .then((l) => {
        if (selectedRef.current === client.id) setLoyalty(l);
      })
      .catch(() => setLoyalty(null)); // no plan / no programme: nothing to show
    try {
      const data = (await apiClient.getClientWallet(client.id)) as unknown as WalletView;
      if (selectedRef.current === client.id) setWallet(data);
    } catch {
      // No wallet yet: the first deposit creates it.
      if (selectedRef.current === client.id) setWallet(null);
    } finally {
      if (selectedRef.current === client.id) setWalletLoading(false);
    }
  };

  const openMovement = (kind: "deposit" | "withdraw") => {
    setMovement(kind);
    setAmount("");
    setNote("");
    setMovementError(null);
    setTopUpMethod(null);
    // Cash in or out goes through the drawer: whether it is open, said before asking.
    setDrawerOpen(null);
    apiClient
      .getCurrentCashSession()
      .then((c) => setDrawerOpen(!!c.session))
      .catch(() => setDrawerOpen(null)); // unknown: the server decides
  };

  const saveMovement = async () => {
    if (!selected || !movement) return;
    const cents = parseEurosToCents(amount);
    if (cents === null) {
      setMovementError("Escribe un importe en euros mayor que 0, por ejemplo 20 o 12,50.");
      return;
    }
    if (movement === "withdraw" && cents > (wallet?.balance ?? 0)) {
      setMovementError(`El saldo es ${formatEuros(wallet?.balance ?? 0)}: no se puede retirar más.`);
      return;
    }
    const tenderIssue = topUpProblem(topUpMethod, drawerOpen, movement);
    if (tenderIssue) {
      setMovementError(t(tenderIssue));
      return;
    }
    setSaving(true);
    setMovementError(null);
    try {
      if (movement === "deposit") {
        await apiClient.depositToWallet(selected.id, cents, topUpMethod!, note.trim() || undefined);
      } else {
        await apiClient.withdrawFromWallet(selected.id, cents, topUpMethod!, note.trim() || undefined);
      }
      toast({
        title: movement === "deposit" ? "Ingreso registrado" : "Retirada registrada",
        description:
          movement === "deposit"
            ? `${formatEuros(cents)} ingresados en la cartera (${methodLabel(topUpMethod!).toLowerCase()}).`
            : `${formatEuros(cents)} retirados de la cartera (${methodLabel(topUpMethod!).toLowerCase()}).`,
      });
      setMovement(null);
      await loadWallet(selected);
    } catch (error) {
      setMovementError(
        error instanceof Error
          ? error.message
          : movement === "deposit"
            ? t("payments.deposit_failed")
            : "No se pudo registrar la retirada.",
      );
    } finally {
      setSaving(false);
    }
  };

  const balance = wallet?.balance ?? 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Client search */}
        <div className="rounded-lg bg-white p-6 shadow">
          <h3 className="mb-4 text-lg font-semibold">{t("payments.select_client")}</h3>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nombre, email o teléfono"
            className="mb-3 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label="Buscar clienta"
          />
          <div className="max-h-96 space-y-2 overflow-y-auto">
            {searching && clients.length === 0 ? (
              <p className="py-4 text-center text-sm text-gray-500">Buscando…</p>
            ) : clients.length === 0 ? (
              <p className="py-4 text-center text-sm text-gray-500">Ninguna clienta coincide con la búsqueda.</p>
            ) : (
              clients.map((client) => (
                <button
                  key={client.id}
                  onClick={() => void loadWallet(client)}
                  className={`w-full rounded-lg p-3 text-left transition-colors ${
                    selected?.id === client.id
                      ? "border border-blue-500 bg-blue-50"
                      : "border border-transparent hover:bg-gray-50"
                  }`}
                >
                  <div className="font-medium">
                    {client.firstName} {client.lastName}
                  </div>
                  <div className="text-sm text-gray-500">{client.email || client.phone || ""}</div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Wallet */}
        <div className="rounded-lg bg-white p-6 shadow">
          <h3 className="mb-4 text-lg font-semibold">{t("payments.wallet_details")}</h3>
          {!selected ? (
            <p className="py-8 text-center text-gray-500">{t("payments.select_client_to_view_wallet")}</p>
          ) : walletLoading ? (
            <p className="py-8 text-center text-gray-500">Cargando…</p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between rounded-lg bg-gray-50 p-4">
                <div>
                  <span className="text-gray-600">{t("payments.balance")}</span>
                  {!wallet && <div className="text-xs text-gray-500">{t("payments.no_wallet_found")}</div>}
                </div>
                <span className="text-2xl font-bold text-green-600">{formatEuros(balance)}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-gray-50 p-4">
                <div>
                  <span className="text-gray-600">{t("payments.loyalty_points")}</span>
                  <Link href="/dashboard/loyalty" className="block text-xs text-blue-600 hover:underline">
                    {t("payments.manage_in_loyalty")}
                  </Link>
                </div>
                {loyalty?.member ? (
                  <span className="text-2xl font-bold text-blue-600">{loyalty.member.currentPoints}</span>
                ) : (
                  <span className="text-sm text-gray-500">{t("payments.not_in_loyalty")}</span>
                )}
              </div>

              {manager && (
                <div className="border-t pt-4">
                  <h4 className="mb-3 font-medium">{t("payments.quick_actions")}</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => openMovement("deposit")}
                      className="rounded bg-green-600 px-3 py-2 text-white hover:bg-green-700"
                    >
                      {t("payments.deposit_funds")}
                    </button>
                    <button
                      onClick={() => openMovement("withdraw")}
                      disabled={balance <= 0}
                      className="rounded bg-red-600 px-3 py-2 text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {t("payments.withdraw_funds")}
                    </button>
                  </div>
                </div>
              )}

              {wallet?.transactions && wallet.transactions.length > 0 && (
                <div className="border-t pt-4">
                  <h4 className="mb-2 font-medium">Últimos movimientos</h4>
                  <ul className="space-y-1 text-sm">
                    {wallet.transactions.slice(0, 10).map((tx) => (
                      <li key={tx.id} className="flex justify-between gap-2">
                        <span className="truncate text-gray-600">
                          {new Date(tx.createdAt).toLocaleDateString("es-ES")} · {tx.description || (tx.type === "credit" ? "Ingreso" : "Cobro")}
                          {tx.method && !/^(Recarga|Retirada)/.test(tx.description ?? "") ? ` · ${methodLabel(tx.method)}` : ""}
                        </span>
                        <span className={tx.type === "credit" ? "text-green-700" : "text-red-700"}>
                          {tx.type === "credit" ? "+" : "−"}
                          {formatEuros(tx.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!movement}
        title={movement === "withdraw" ? "Retirar de la cartera" : "Ingresar en la cartera"}
        description={
          <div className="space-y-3">
            <p>
              {selected ? `${selected.firstName} ${selected.lastName}`.trim() : ""} · saldo {formatEuros(balance)}
            </p>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-700">
                {movement === "withdraw" ? t("payments.enter_withdraw_amount") : t("payments.enter_deposit_amount")} (€)
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            {movement && (
              <fieldset>
                <legend className="mb-1 block text-xs font-medium text-gray-700">
                  {movement === "deposit" ? t("payments.top_up_method") : t("payments.withdraw_method")}
                </legend>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup">
                  {WALLET_TOP_UP_METHODS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={topUpMethod === m}
                      onClick={() => {
                        setTopUpMethod(m);
                        setMovementError(null);
                      }}
                      className={`rounded-md border px-2 py-2 text-sm font-medium ${
                        topUpMethod === m ? "border-blue-600 bg-blue-600 text-white" : "bg-white text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      {methodLabel(m)}
                    </button>
                  ))}
                </div>
                {topUpMethod === "cash" && (
                  <p className={`mt-1 text-xs ${drawerOpen === false ? "text-red-700" : "text-gray-500"}`}>
                    {movement === "deposit"
                      ? drawerOpen === false
                        ? t("payments.top_up_drawer_closed")
                        : t("payments.top_up_cash_hint")
                      : drawerOpen === false
                        ? t("payments.withdraw_drawer_closed")
                        : t("payments.withdraw_cash_hint")}
                  </p>
                )}
              </fieldset>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-700">Nota (opcional)</span>
              <input
                type="text"
                value={note}
                maxLength={500}
                onChange={(e) => setNote(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
            {movementError && (
              <p role="alert" className="text-xs text-red-700">
                {movementError}
              </p>
            )}
          </div>
        }
        confirmLabel={movement === "withdraw" ? "Retirar" : "Ingresar"}
        cancelLabel="Cancelar"
        destructive={movement === "withdraw"}
        loading={saving}
        onCancel={() => setMovement(null)}
        onConfirm={saveMovement}
      />
    </div>
  );
}
