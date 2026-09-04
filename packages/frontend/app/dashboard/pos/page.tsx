"use client";

import { useState, useEffect } from "react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useToast, toast } from "@/components/ui/use-toast";
import AppointmentSelector from "./components/appointment-selector";

interface Service {
  id: string;
  name: string;
  price: number;
  category: string;
  duration: number;
}

interface Client {
  id: string;
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
}

interface CartItem {
  service: Service;
  quantity: number;
}

interface POSSummary {
  date: string;
  totalSales: number;
  totalTransactions: number;
  pendingPayments: number;
  refundedAmount: number;
  paymentBreakdown: { method: string; amount: number; count: number }[];
  topServices: { name: string; count: number; revenue: number }[];
}

interface TodayPayment {
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
  method: "card" | "cash" | "bank_transfer" | "wallet" | "gift_card";
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

export default function POSPage() {
  const t = useTranslations();
  const [services, setServices] = useState<Service[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [allClients, setAllClients] = useState<Client[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<
    "cash" | "card"
  >("cash");
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [summary, setSummary] = useState<POSSummary | null>(null);
  const [clientSearch, setClientSearch] = useState("");
  const [showClientSearch, setShowClientSearch] = useState(false);
  const [lastSale, setLastSale] = useState<any>(null);
  const [todayPayments, setTodayPayments] = useState<TodayPayment[]>([]);
  const [cashTotal, setCashTotal] = useState(0);
  const [cardTotal, setCardTotal] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const { toast } = useToast();
  
  // Appointment payment integration
  const [showAppointmentSelector, setShowAppointmentSelector] = useState(false);
  const [selectedAppointments, setSelectedAppointments] = useState<any[]>([]);

  // Filter states
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [methodFilter, setMethodFilter] = useState<string>("");
  const [clientFilter, setClientFilter] = useState<string>("");
  const [clientSearchQuery, setClientSearchQuery] = useState<string>("");
  const [serviceFilter, setServiceFilter] = useState<string>("");

  // Pagination states
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [totalPayments, setTotalPayments] = useState<number>(0);

  // Sorting states
  const [sortBy, setSortBy] = useState<string>("createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Check if user is admin
  useEffect(() => {
    const token = localStorage.getItem("kira_auth_token");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        setIsAdmin(payload.role === "admin" || payload.role === "owner");
      } catch (e) {
        console.error("Failed to parse token:", e);
      }
    }
  }, []);

  useEffect(() => {
    loadData();
    loadAllClients();
  }, []);

  // Get tenantId from token
  const getTenantId = (): string | undefined => {
    const token = localStorage.getItem("kira_auth_token");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        return payload.tenantId;
      } catch (e) {
        console.error("Failed to decode token:", e);
      }
    }
    return undefined;
  };

  // Load payments with filters, pagination, sorting
  const loadPayments = async () => {
    try {
      const tenantId = getTenantId();
      if (!tenantId) {
        console.warn("No tenantId available");
        return;
      }

      // Build date range for today
      const today = new Date();
      const startOfDay = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
      );
      const endOfDay = new Date(startOfDay);
      endOfDay.setHours(23, 59, 59, 999);

      const params: any = {
        tenantId,
        dateFrom: startOfDay.toISOString(),
        dateTo: endOfDay.toISOString(),
        page: currentPage,
        limit: pageSize,
        sortBy,
        sortOrder,
      };

      if (statusFilter) params.status = statusFilter;
      if (methodFilter) params.method = methodFilter;
      if (clientFilter) params.clientId = clientFilter;

      const response = await apiClient.getPayments(params);

      let paymentsArray: TodayPayment[] = response.payments as TodayPayment[];

      // Apply frontend filters that backend doesn't support
      if (methodFilter) {
        paymentsArray = paymentsArray.filter(
          (payment) => payment.method === methodFilter,
        );
      }

      // Apply service filter (by description)
      if (serviceFilter) {
        const lower = serviceFilter.toLowerCase();
        paymentsArray = paymentsArray.filter(
          (payment) =>
            payment.description &&
            payment.description.toLowerCase().includes(lower),
        );
      }

      // Extract pagination info
      if (response.pagination) {
        setTotalPages(response.pagination.totalPages);
        setTotalPayments(response.pagination.total);
      }

      setTodayPayments(paymentsArray);
    } catch (error) {
      console.error("Failed to load payments:", error);
      setTodayPayments([]);
    }
  };

  // Reload payments when any filter, pagination, or sorting changes
  useEffect(() => {
    loadPayments();
  }, [
    statusFilter,
    methodFilter,
    clientFilter,
    serviceFilter,
    currentPage,
    pageSize,
    sortBy,
    sortOrder,
  ]);

  const loadData = async () => {
    try {
      setLoading(true);
      console.log("Loading POS data...");

      const [servicesData, summaryData] = await Promise.all([
        apiClient.getPosServices().catch((err) => {
          console.error("Failed to load services:", err);
          return [];
        }),
        apiClient.getPosDashboard().catch((err) => {
          console.error("Failed to load dashboard:", err);
          return null;
        }),
      ]);

      setServices(servicesData || []);
      setSummary(summaryData);

      // Compute cash and card totals from summary breakdown
      if (summaryData?.paymentBreakdown) {
        const cashBreakdown = summaryData.paymentBreakdown.find(
          (p: any) => p.method === "cash",
        );
        const cardBreakdown = summaryData.paymentBreakdown.find(
          (p: any) => p.method === "card",
        );
        setCashTotal(cashBreakdown?.amount || 0);
        setCardTotal(cardBreakdown?.amount || 0);
      }

      // Load payments separately with filters
      await loadPayments();
    } catch (error) {
      console.error("Failed to load POS data:", error);
    } finally {
      setLoading(false);
    }
  };

  const searchClients = async (query: string) => {
    if (!query) {
      setClients([]);
      return;
    }
    try {
      const data = await apiClient.getPosClients(query);
      setClients(data);
    } catch (error) {
      console.error("Failed to search clients:", error);
    }
  };

  const loadAllClients = async () => {
    try {
      const data = await apiClient.getClients();
      setAllClients(data);
    } catch (error) {
      console.error("Failed to load clients:", error);
    }
  };

  const addToCart = (service: Service) => {
    const existing = cart.find((item) => item.service.id === service.id);
    if (existing) {
      setCart(
        cart.map((item) =>
          item.service.id === service.id
            ? { ...item, quantity: item.quantity + 1 }
            : item,
        ),
      );
    } else {
      setCart([...cart, { service, quantity: 1 }]);
    }
  };

  const removeFromCart = (serviceId: string) => {
    setCart(cart.filter((item) => item.service.id !== serviceId));
  };

  const updateQuantity = (serviceId: string, quantity: number) => {
    if (quantity <= 0) {
      removeFromCart(serviceId);
      return;
    }
    setCart(
      cart.map((item) =>
        item.service.id === serviceId ? { ...item, quantity } : item,
      ),
    );
  };

  const calculateTotal = () => {
    return cart.reduce(
      (sum, item) => sum + item.service.price * item.quantity,
      0,
    );
  };

  const processCheckout = async () => {
    if (cart.length === 0) return;

    // If appointments are selected, use appointment payment flow
    if (selectedAppointments.length > 0) {
      await handleAppointmentPayment();
      return;
    }

    try {
      setProcessing(true);
      const items = cart.map((item) => ({
        serviceId: item.service.id,
        name: item.service.name,
        price: Math.round(item.service.price * 100), // Convert to cents
        quantity: item.quantity,
      }));

      const checkoutData = {
        // tenantId is obtained from JWT token via API
        clientId: selectedClient?.id,
        items,
        payments: [
          {
            method: selectedPaymentMethod,
            amount: Math.round(calculateTotal() * 100),
          },
        ],
      };

      console.log("Starting POS checkout with data:", checkoutData);

      const result = await apiClient.posCheckout(checkoutData);

      console.log("POS checkout result:", result);

      // Show success message
      toast({
        title: t("pos.sale_completed"),
        description: t("pos.payment_completed"),
      });

      // Clear cart and reset
      setCart([]);
      setSelectedClient(null);

      // Refresh all data after a short delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      await loadData();
    } catch (error: any) {
      console.error("Checkout failed:", error);
      const errorMessage =
        error?.message || error?.response?.data?.message || "Unknown error";
      console.log("Checkout error, showing toast:", errorMessage);
      toast({
        title: t("pos.checkout_failed"),
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setProcessing(false);
    }
  };

  const processQuickSale = async (service: Service) => {
    try {
      setProcessing(true);

      const result = await apiClient.posQuickSale({
        serviceId: service.id,
        paymentMethod: selectedPaymentMethod,
        clientId: selectedClient?.id,
      });

      console.log("POS quick sale result:", result);

      // Show success message
      const clientName = selectedClient
        ? `${selectedClient.firstName} ${selectedClient.lastName}`
        : "Walk-in";

      toast({
        title: t("pos.quick_sale_completed"),
        description: `${clientName} - ${service.name} x1 = ${formatCurrency(service.price)}`,
      });

      // Clear cart and reset
      setCart([]);
      setSelectedClient(null);

      // Refresh all data after a short delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      await loadData();
    } catch (error: any) {
      console.error("Quick sale failed:", error);
      const errorMessage =
        error?.message || error?.response?.data?.message || "Unknown error";
      toast({
        title: t("pos.quick_sale_failed"),
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setProcessing(false);
    }
  };

  const handleDeletePayment = async (paymentId: string) => {
    if (!confirm(t("pos.payment_cancelled_description"))) return;

    try {
      await apiClient.deletePayment(paymentId);
      toast({
        title: t("pos.payment_cancelled"),
        description: t("pos.payment_cancelled_description"),
      });
      // Refresh both summary and payments
      await Promise.all([
        apiClient
          .getPosDashboard()
          .then(setSummary)
          .catch(() => {}),
        loadPayments(),
      ]);
    } catch (error) {
      console.error("Failed to cancel payment:", error);
      toast({
        title: t("pos.payment_failed"),
        description: t("pos.payment_delete_failed"),
        variant: "destructive",
      });
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-EU", {
      style: "currency",
      currency: "EUR",
    }).format(amount);
  };

  const handleSelectAppointments = (appointments: any[]) => {
    setSelectedAppointments(appointments);
    setSelectedClient(appointments[0].client);

    // Add all appointment services to cart
    const newCartItems = appointments.map((appointment: any) => ({
      service: {
        id: appointment.service.id,
        name: `${appointment.service.name} (${appointment.client.firstName} ${appointment.client.lastName})`,
        price: appointment.totalAmount / 100, // Convert from cents
        category: "other" as any,
        duration: appointment.service.duration || 60,
      },
      quantity: 1,
      _appointmentId: appointment.id,
    }));
    setCart(newCartItems);

    const totalAmount = appointments.reduce((sum: number, a: any) => sum + a.totalAmount / 100, 0);
    toast({
      title: t("pos.appointments_selected") || `${appointments.length} appointments selected`,
      description: `${appointments.map((a: any) => `${a.client.firstName} ${a.client.lastName}`).join(", ")} — ${formatCurrency(totalAmount)}`,
    });
  };

  const handleAppointmentPayment = async () => {
    if (selectedAppointments.length === 0) return;

    try {
      setProcessing(true);

      // Calculate total across all appointments (in cents)
      const totalAmountCents = selectedAppointments.reduce(
        (sum, apt) => sum + apt.totalAmount,
        0
      );

      const items = cart.map((item) => ({
        serviceId: item.service.id,
        name: item.service.name,
        price: Math.round(item.service.price * 100),
        quantity: item.quantity,
      }));

      const checkoutData = {
        clientId: selectedAppointments[0].client.id,
        appointmentIds: selectedAppointments.map((apt: any) => apt.id),
        items,
        payments: [
          {
            method: selectedPaymentMethod,
            amount: totalAmountCents,
            type: "appointment" as const,
            isDeposit: false,
          },
        ],
      };

      const result = await apiClient.posCheckout(checkoutData);

      // Update payment status for each appointment
      for (const apt of selectedAppointments) {
        await apiClient.updateAppointmentPayment(apt.id, {
          status: "paid",
          amountPaid: apt.totalAmount,
          paymentMethod: selectedPaymentMethod,
        });
      }

      toast({
        title: t("pos.payment_completed"),
        description: `${selectedAppointments.length} ${t("pos.appointment_payment_success").toLowerCase()}`,
      });

      // Clear selection and cart
      setSelectedAppointments([]);
      setCart([]);
      setSelectedClient(null);

      // Refresh data
      await loadData();
    } catch (error: any) {
      console.error("Appointment payment failed:", error);
      toast({
        title: t("pos.payment_failed"),
        description: error.message || "Payment processing failed",
        variant: "destructive",
      });
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg">Loading POS...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold truncate">{t("pos.title")}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setShowAppointmentSelector(true)}
            className="px-4 py-2 rounded-lg bg-purple-600 text-white hover:bg-purple-700"
          >
            {t("pos.select_appointment")}
          </button>
        </div>
      </div>

      {showAppointmentSelector && (
        <AppointmentSelector
          onSelectAppointments={handleSelectAppointments}
          onClose={() => setShowAppointmentSelector(false)}
        />
      )}

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <div className="bg-white p-4 rounded-lg shadow">
            <div className="text-sm text-gray-500">{t("pos.today_sales")}</div>
            <div className="text-2xl font-bold text-green-600">
              {formatCurrency(summary.totalSales / 100)}
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow">
            <div className="text-sm text-gray-500">{t("pos.transactions")}</div>
            <div className="text-2xl font-bold">
              {summary.totalTransactions}
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow">
            <div className="text-sm text-gray-500">{t("pos.pending")}</div>
            <div className="text-2xl font-bold text-yellow-600">
              {summary.pendingPayments}
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow">
            <div className="text-sm text-gray-500">{t("pos.refunded")}</div>
            <div className="text-2xl font-bold text-red-600">
              {formatCurrency(summary.refundedAmount / 100)}
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow">
            <div className="text-sm text-gray-500">
              {t("pos.cash").replace("💵 ", "")}
            </div>
            <div className="text-2xl font-bold text-blue-600">
              {formatCurrency(cashTotal / 100)}
            </div>
          </div>
          <div className="bg-white p-4 rounded-lg shadow">
            <div className="text-sm text-gray-500">
              {t("pos.card").replace("💳 ", "")}
            </div>
            <div className="text-2xl font-bold text-purple-600">
              {formatCurrency(cardTotal / 100)}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Services Grid */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-lg shadow">
            <div className="p-4 border-b">
              <h2 className="text-lg font-semibold">{t("pos.services")}</h2>
            </div>
            <div className="p-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {services.map((service) => (
                  <button
                    key={service.id}
                    onClick={() => addToCart(service)}
                    className="p-3 border rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors text-left"
                  >
                    <div className="font-medium text-sm truncate">
                      {service.name}
                    </div>
                    <div className="text-lg font-bold text-green-600">
                      {formatCurrency(service.price)}
                    </div>
                    <div className="text-xs text-gray-500">
                      {service.duration} min
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        processQuickSale(service);
                      }}
                      className="mt-2 w-full text-xs bg-blue-600 text-white py-1 rounded hover:bg-blue-700"
                      disabled={processing}
                    >
                      {t("pos.quick_sale")}
                    </button>
                  </button>
                ))}
              </div>
              {services.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  {t("pos.no_services_available")}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Cart / Checkout */}
        <div>
          <div className="bg-white rounded-lg shadow">
            <div className="p-4 border-b">
              <h2 className="text-lg font-semibold">{t("pos.cart")}</h2>
            </div>
            <div className="p-4">
        {/* Appointment Info */}
        {selectedAppointments.length > 0 && (
          <div className="mb-4 border border-blue-200 bg-blue-50 rounded-lg p-3">
            <div className="flex justify-between items-start mb-2">
              <div>
                <div className="font-semibold text-blue-900">
                  {t("pos.appointment_details")} ({selectedAppointments.length})
                </div>
              </div>
              <button
                onClick={() => {
                  setSelectedAppointments([]);
                  setCart([]);
                }}
                className="text-red-600 text-sm hover:underline"
              >
                {t("pos.remove")}
              </button>
            </div>
            <div className="space-y-2 mb-3">
              {selectedAppointments.map((apt) => (
                <div key={apt.id} className="text-sm text-blue-800 flex justify-between items-center">
                  <div>
                    <span className="font-medium">{apt.client.firstName} {apt.client.lastName}</span>
                    <span className="text-blue-600"> — {apt.service.name}</span>
                    <div className="text-xs text-blue-500">
                      {new Date(apt.scheduledDate).toLocaleDateString()} {apt.scheduledTime}
                    </div>
                  </div>
                  <span className="font-semibold text-blue-900 ml-2 whitespace-nowrap">
                    {formatCurrency(apt.totalAmount / 100)}
                  </span>
                </div>
              ))}
            </div>
            <div className="border-t border-blue-200 pt-2 flex justify-between items-center text-sm">
              <span className="font-semibold text-blue-800">{t("pos.total")}:</span>
              <span className="font-bold text-blue-900 text-base">
                {formatCurrency(selectedAppointments.reduce((sum, apt) => sum + apt.totalAmount / 100, 0))}
              </span>
            </div>
          </div>
        )}

        {/* Client Selection */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            {t("pos.client_optional")}
          </label>
          {selectedClient && selectedAppointments.length === 0 ? (
            <div className="flex items-center justify-between bg-gray-100 p-2 rounded">
              <span>
                {selectedClient.firstName} {selectedClient.lastName}
              </span>
              <button
                onClick={() => setSelectedClient(null)}
                className="text-red-600 text-sm"
              >
                {t("pos.remove")}
              </button>
            </div>
          ) : selectedAppointments.length === 0 ? (
            <button
              onClick={() => setShowClientSearch(!showClientSearch)}
              className="w-full text-left px-3 py-2 border rounded-lg text-gray-500"
            >
              {t("pos.add_client")}
            </button>
          ) : null}
          {showClientSearch && (
            <div className="mt-2">
              <input
                type="text"
                placeholder={t("pos.search_client")}
                value={clientSearch}
                onChange={(e) => {
                  setClientSearch(e.target.value);
                  searchClients(e.target.value);
                }}
                className="w-full px-3 py-2 border rounded-lg"
              />
              {clients.length > 0 && (
                <div className="mt-2 border rounded-lg max-h-32 overflow-y-auto">
                  {clients.map((client) => (
                    <button
                      key={client.id}
                      onClick={() => {
                        setSelectedClient(client);
                        setShowClientSearch(false);
                        setClientSearch("");
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-100"
                    >
                      {client.firstName} {client.lastName}
                      {client.phone && (
                        <span className="text-gray-500">
                          {" "}
                          - {client.phone}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

              {/* Cart Items */}
              <div className="space-y-2 mb-4">
                {cart.map((item) => (
                  <div
                    key={item.service.id}
                    className="flex items-center justify-between border-b pb-2"
                  >
                    <div className="flex-1">
                      <div className="font-medium text-sm">
                        {item.service.name}
                      </div>
                      <div className="text-xs text-gray-500">
                        {formatCurrency(item.service.price)} × {item.quantity}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() =>
                          updateQuantity(item.service.id, item.quantity - 1)
                        }
                        className="w-6 h-6 rounded bg-gray-200 text-gray-600"
                      >
                        -
                      </button>
                      <span className="w-4 text-center">{item.quantity}</span>
                      <button
                        onClick={() =>
                          updateQuantity(item.service.id, item.quantity + 1)
                        }
                        className="w-6 h-6 rounded bg-gray-200 text-gray-600"
                      >
                        +
                      </button>
                      <button
                        onClick={() => removeFromCart(item.service.id)}
                        className="text-red-600 text-sm ml-2"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
                {cart.length === 0 && (
                  <div className="text-center py-4 text-gray-500">
                    {t("pos.cart_empty")}
                  </div>
                )}
              </div>

              {/* Total */}
              <div className="border-t pt-4">
                <div className="flex justify-between text-lg font-bold">
                  <span>{t("pos.total")}</span>
                  <span>{formatCurrency(calculateTotal())}</span>
                </div>
              </div>

              {/* Payment Method Toggle */}
              <div className="mt-4 mb-4">
                <label className="block text-sm font-medium text-gray-500 mb-2">
                  {t("pos.method")}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setSelectedPaymentMethod("cash")}
                    className={`flex items-center justify-center gap-2 py-3 rounded-lg font-semibold transition-all ${
                      selectedPaymentMethod === "cash"
                        ? "bg-green-600 text-white shadow-md ring-2 ring-green-300"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
                    </svg>
                    {t("pos.cash")}
                  </button>
                  <button
                    onClick={() => setSelectedPaymentMethod("card")}
                    className={`flex items-center justify-center gap-2 py-3 rounded-lg font-semibold transition-all ${
                      selectedPaymentMethod === "card"
                        ? "bg-blue-600 text-white shadow-md ring-2 ring-blue-300"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                    </svg>
                    {t("pos.card")}
                  </button>
                </div>
              </div>

        {/* Checkout Button */}
        <button
          onClick={processCheckout}
          disabled={cart.length === 0 || processing}
          className={`w-full py-3 rounded-lg font-semibold ${
            cart.length === 0 || processing
              ? "bg-gray-300 text-gray-500 cursor-not-allowed"
              : selectedPaymentMethod === "cash"
              ? "bg-green-600 text-white hover:bg-green-700"
              : "bg-blue-600 text-white hover:bg-blue-700"
          }`}
        >
          {processing
            ? t("pos.processing")
            : selectedAppointments.length > 0
            ? `${t("pos.pay_full_amount")} (${selectedAppointments.length})`
            : selectedPaymentMethod === "cash"
            ? t("pos.pay_cash")
            : t("pos.pay_card")}
        </button>
            </div>
          </div>
        </div>
      </div>

      {/* Today's Payments */}
      <div className="bg-white rounded-lg shadow">
        <div className="p-4 border-b">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">{t("pos.today_payments")}</h2>
            <button
              onClick={loadPayments}
              disabled={loading}
              className="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:bg-blue-400 flex items-center gap-1"
            >
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
              {t("common.refresh")}
            </button>
          </div>

          {/* Filters */}
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {/* Status Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("payments.status")}
              </label>
              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              >
                <option value="">{t("common.all")}</option>
                <option value="pending">{t("payments.status_pending")}</option>
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
                onChange={(e) => {
                  setMethodFilter(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
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

            {/* Client Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("pos.client")}
              </label>
              <input
                type="text"
                list="clients-list"
                value={clientSearchQuery}
                onChange={(e) => {
                  const val = e.target.value;
                  setClientSearchQuery(val);
                  const client = allClients.find(
                    (c) => `${c.firstName} ${c.lastName}` === val,
                  );
                  setClientFilter(client ? client.id : "");
                }}
                placeholder={t("pos.search_client")}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              />
              <datalist id="clients-list">
                {allClients.map((client) => (
                  <option
                    key={client.id}
                    value={`${client.firstName} ${client.lastName}`}
                  />
                ))}
              </datalist>
              {clientFilter && (
                <button
                  type="button"
                  onClick={() => {
                    setClientFilter("");
                    setClientSearchQuery("");
                  }}
                  className="mt-1 text-xs text-red-600 hover:underline"
                >
                  {t("common.clear")}
                </button>
              )}
            </div>

            {/* Service Filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("pos.service")}
              </label>
              <input
                type="text"
                value={serviceFilter}
                onChange={(e) => {
                  setServiceFilter(e.target.value);
                  setCurrentPage(1);
                }}
                placeholder={t("pos.search_service")}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
              />
            </div>

            {/* Clear Filters */}
            <div className="flex items-end">
              <button
                onClick={() => {
                  setStatusFilter("");
                  setMethodFilter("");
                  setClientFilter("");
                  setClientSearchQuery("");
                  setServiceFilter("");
                  setCurrentPage(1);
                }}
                className="w-full px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                {t("common.clear")}
              </button>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-[720px] w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th
                  className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => {
                    setSortBy("id");
                    setSortOrder(sortOrder === "asc" ? "desc" : "asc");
                    setCurrentPage(1);
                  }}
                >
                  <div className="flex items-center">
                    {t("pos.id")}
                    {sortBy === "id" && (
                      <svg
                        className="w-4 h-4 ml-1 text-blue-600"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d={
                            sortOrder === "asc"
                              ? "M5 15l7-7 7 7"
                              : "M19 9l-7 7-7-7"
                          }
                        />
                      </svg>
                    )}
                  </div>
                </th>
                <th
                  className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => {
                    setSortBy("createdAt");
                    setSortOrder(sortOrder === "asc" ? "desc" : "asc");
                    setCurrentPage(1);
                  }}
                >
                  <div className="flex items-center">
                    {t("pos.time")}
                    {sortBy === "createdAt" && (
                      <svg
                        className="w-4 h-4 ml-1 text-blue-600"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d={
                            sortOrder === "asc"
                              ? "M5 15l7-7 7 7"
                              : "M19 9l-7 7-7-7"
                          }
                        />
                      </svg>
                    )}
                  </div>
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t("pos.client")}
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t("pos.description")}
                </th>
                <th
                  className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => {
                    setSortBy("amount");
                    setSortOrder(sortOrder === "asc" ? "desc" : "asc");
                    setCurrentPage(1);
                  }}
                >
                  <div className="flex items-center">
                    {t("pos.amount")}
                    {sortBy === "amount" && (
                      <svg
                        className="w-4 h-4 ml-1 text-blue-600"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d={
                            sortOrder === "asc"
                              ? "M5 15l7-7 7 7"
                              : "M19 9l-7 7-7-7"
                          }
                        />
                      </svg>
                    )}
                  </div>
                </th>
                <th
                  className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => {
                    setSortBy("method");
                    setSortOrder(sortOrder === "asc" ? "desc" : "asc");
                    setCurrentPage(1);
                  }}
                >
                  <div className="flex items-center">
                    {t("pos.method")}
                    {sortBy === "method" && (
                      <svg
                        className="w-4 h-4 ml-1 text-blue-600"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d={
                            sortOrder === "asc"
                              ? "M5 15l7-7 7 7"
                              : "M19 9l-7 7-7-7"
                          }
                        />
                      </svg>
                    )}
                  </div>
                </th>
                <th
                  className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 transition-colors"
                  onClick={() => {
                    setSortBy("status");
                    setSortOrder(sortOrder === "asc" ? "desc" : "asc");
                    setCurrentPage(1);
                  }}
                >
                  <div className="flex items-center">
                    {t("pos.status")}
                    {sortBy === "status" && (
                      <svg
                        className="w-4 h-4 ml-1 text-blue-600"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d={
                            sortOrder === "asc"
                              ? "M5 15l7-7 7 7"
                              : "M19 9l-7 7-7-7"
                          }
                        />
                      </svg>
                    )}
                  </div>
                </th>
                {isAdmin && (
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    {t("pos.action")}
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {todayPayments.length === 0 ? (
                <tr>
                  <td
                    colSpan={isAdmin ? 8 : 7}
                    className="px-4 py-8 text-center text-gray-500"
                  >
                    {t("pos.no_payments_today")}
                  </td>
                </tr>
              ) : (
                todayPayments.map((payment) => (
                  <tr key={payment.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-sm font-mono text-gray-900">
                      {payment.id.slice(0, 8)}...
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-500">
                      {new Date(payment.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-900">
                      {payment.client &&
                      typeof payment.client === "object" &&
                      payment.client.firstName &&
                      payment.client.lastName
                        ? `${payment.client.firstName} ${payment.client.lastName}`
                        : "-"}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-500">
                      {payment.description || "-"}
                    </td>
                    <td className="px-4 py-2 text-sm font-medium text-gray-900">
                      {formatCurrency(payment.amount / 100)}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-500 capitalize">
                      {payment.method === "card"
                        ? t("payments.payment_methods.card")
                        : payment.method === "cash"
                          ? t("payments.payment_methods.cash")
                          : payment.method === "bank_transfer"
                            ? t("payments.payment_methods.bank_transfer")
                            : payment.method === "wallet"
                              ? t("payments.payment_methods.wallet")
                              : payment.method}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                          payment.status === "succeeded"
                            ? "bg-green-100 text-green-800"
                            : payment.status === "pending" ||
                                payment.status === "processing"
                              ? "bg-yellow-100 text-yellow-800"
                              : "bg-red-100 text-red-800"
                        }`}
                      >
                        {payment.status === "succeeded"
                          ? t("payments.status_succeeded")
                          : payment.status === "pending"
                            ? t("payments.status_pending")
                            : payment.status === "processing"
                              ? t("payments.status_processing")
                              : payment.status === "failed"
                                ? t("payments.status_failed")
                                : payment.status === "cancelled"
                                  ? t("payments.status_cancelled")
                                  : payment.status === "refunded"
                                    ? t("payments.status_refunded")
                                    : payment.status === "partially_refunded"
                                      ? t("payments.status_partially_refunded")
                                      : payment.status}
                      </span>
                    </td>
                    {isAdmin &&
                      payment.status !== "cancelled" &&
                      payment.status !== "refunded" && (
                        <td className="px-4 py-2">
                          <button
                            onClick={() => handleDeletePayment(payment.id)}
                            className="text-red-600 hover:text-red-800 text-sm"
                          >
                            {t("pos.cancel")}
                          </button>
                        </td>
                      )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {totalPages > 1 && (
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
                  {t("payments.to")}{" "}
                  <span className="font-medium">
                    {Math.min(currentPage * pageSize, totalPayments)}
                  </span>{" "}
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
                      setCurrentPage(1);
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
        )}
      </div>
    </div>
  );
}
