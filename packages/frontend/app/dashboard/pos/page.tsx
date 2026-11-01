"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import apiClient from "@/lib/api";
import type { ClientLoyaltySummary, PosQuote, PosSaleProduct, Professional } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { RefundPaymentDialog } from "@/components/payments/RefundPaymentDialog";
import { PAYMENT_STATUS_LABELS, methodLabel, refundableCents, statusLabel } from "@/lib/payments-format";
import AppointmentSelector from "./components/appointment-selector";
import DiscountEditor from "./components/discount-editor";
import TenderPanel from "./components/tender-panel";
import SaleReceipt from "./components/sale-receipt";
import GiftCardSaleDialog from "./components/gift-card-sale-dialog";
import CashDrawer from "./components/cash-drawer";
import { drawerProblem } from "@/lib/cash-session";
import { applyDiscounts, discountProblem, staffLimitProblem, type DiscountSpec } from "@/lib/pos-discounts";
import {
  TENDER_LABELS,
  addLine,
  euros as formatEuros,
  giftCardsForServer,
  itemsForServer,
  newSaleId,
  removeLine,
  setProfessional,
  setQuantity,
  tenderProblem,
  tendersForServer,
  tendersOfRows,
  type CartLine,
  type GiftCardSale,
  type TenderMethod,
  type TenderRow,
} from "@/lib/pos-cart";

/**
 * La caja (TPV). Every amount here is money in cents, tax included: what
 * the client pays and what the invoice says (lib/pos-cart.ts). The server
 * prices the ticket (POST /pos/quote) and the panel charges exactly its
 * total; each sale carries a `saleId` so a retry is recorded once.
 */

interface Service {
  id: string;
  name: string;
  price: number | string;
  /** What the till charges, tax included, in cents. */
  chargeCents: number;
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

interface POSSummary {
  date: string;
  totalSales: number;
  totalTransactions: number;
  pendingPayments: number;
  refundedAmount: number;
  paymentBreakdown: { method: string; amount: number; count: number }[];
  topServices: { name: string; count: number; revenue: number }[];
  /** Only this team member's sales (staff). */
  ownSalesOnly?: boolean;
}

interface TodayPayment {
  id: string;
  tenantId: string;
  clientId?: string;
  appointmentId?: string;
  amount: number;
  currency: string;
  type: "appointment" | "deposit" | "product" | "service" | "gift_card" | "membership" | "other";
  /** The server's PaymentStatus enum (a partial refund leaves it "paid"). */
  status: "pending" | "paid" | "failed" | "refunded";
  /** Cents given back so far. */
  refundedAmount?: number;
  method: "card" | "cash" | "bizum" | "bank_transfer" | "wallet" | "gift_card";
  stripePaymentId?: string;
  description?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  paidAt?: string;
  client?: { id: string; firstName: string; lastName: string; email?: string };
  appointment?: { id: string; scheduledDate: string; status: string };
}

/** The methods a quick sale may use (exactly the price, one method). */
const QUICK_METHODS: TenderMethod[] = ["cash", "card", "bizum", "bank_transfer"];

export default function POSPage() {
  const t = useTranslations();
  const { toast } = useToast();
  const [services, setServices] = useState<Service[]>([]);
  const [products, setProducts] = useState<PosSaleProduct[]>([]);
  const [catalogTab, setCatalogTab] = useState<"services" | "products">("services");
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [allClients, setAllClients] = useState<Client[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [giftCards, setGiftCards] = useState<GiftCardSale[]>([]);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [tenderRows, setTenderRows] = useState<TenderRow[]>([{ method: "cash", amountText: "" }]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [summary, setSummary] = useState<POSSummary | null>(null);
  const [clientSearch, setClientSearch] = useState("");
  const [showClientSearch, setShowClientSearch] = useState(false);
  const [todayPayments, setTodayPayments] = useState<TodayPayment[]>([]);
  // The payment being refunded ("Devolver"), in the refund dialog.
  const [pendingVoid, setPendingVoid] = useState<TodayPayment | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showGiftCardSale, setShowGiftCardSale] = useState(false);
  // The receipt of the sale just charged.
  const [receiptOf, setReceiptOf] = useState<{ saleId: string; email?: string | null } | null>(null);
  // The cash drawer (arqueo): open or not (null while loading), and a key
  // bumped after each sale or refund so its expected cash is read again.
  const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null);
  const [drawerKey, setDrawerKey] = useState(0);
  // "Venta rápida": confirmed first, with its amount and concept.
  const [quickSale, setQuickSale] = useState<{ service: Service; method: TenderMethod; saleId: string } | null>(null);

  // Loyalty: the selected client's rewards, and the one being redeemed.
  const [loyalty, setLoyalty] = useState<ClientLoyaltySummary | null>(null);
  const [rewardId, setRewardId] = useState<string>("");

  useEffect(() => {
    setRewardId("");
    setLoyalty(null);
    if (!selectedClient?.id) return;
    apiClient
      .getClientLoyalty(selectedClient.id)
      .then(setLoyalty)
      .catch(() => setLoyalty(null)); // no plan / no programme: nothing to show
  }, [selectedClient?.id]);

  // Manual discounts: one for the whole ticket (the lines carry their own),
  // and how far staff may go (the salon's setting; the server enforces it).
  const [orderDiscount, setOrderDiscount] = useState<DiscountSpec | undefined>(undefined);
  const [maxStaffDiscount, setMaxStaffDiscount] = useState(0);
  const [showDiscountSettings, setShowDiscountSettings] = useState(false);
  const [staffLimitInput, setStaffLimitInput] = useState("0");
  const [savingSettings, setSavingSettings] = useState(false);
  const [confirmingDiscount, setConfirmingDiscount] = useState(false);

  useEffect(() => {
    apiClient
      .getPosSettings()
      .then((s) => {
        setMaxStaffDiscount(s.maxStaffDiscountPercent);
        setStaffLimitInput(String(s.maxStaffDiscountPercent));
      })
      .catch(() => setMaxStaffDiscount(0));
  }, []);

  // The ticket as the server prices it, in money cents: the lines and
  // their discounts (lib/pos-discounts.ts), shown while the quote loads.
  const ticketLines = cart.map((item) => ({ price: item.unitCents, quantity: item.quantity, discount: item.discount }));
  const ticket = applyDiscounts(ticketLines, orderDiscount);
  const giftCardsCents = giftCards.reduce((s, g) => s + g.amountCents, 0);

  // Why the server would refuse the ticket's discounts, said before charging.
  const canDiscount = isAdmin || maxStaffDiscount > 0;
  const discountIssue = (): string | null => {
    for (let i = 0; i < cart.length; i++) {
      const d = cart[i].discount;
      if (d) {
        const problem = discountProblem(d, ticket.lines[i].grossCents, "la línea");
        if (problem) return `${cart[i].name}: ${problem}`;
      }
    }
    if (orderDiscount) {
      const problem = discountProblem(orderDiscount, ticket.orderBaseCents, "el ticket");
      if (problem) return problem;
    }
    return isAdmin ? null : staffLimitProblem(ticketLines, orderDiscount, maxStaffDiscount);
  };
  const issue = discountIssue();
  const discountReasons = [
    ...new Set([...cart.map((i) => i.discount?.reason), orderDiscount?.reason].filter((r): r is string => !!r)),
  ];

  const setLineDiscount = (key: string, discount: DiscountSpec | undefined) => {
    setCart((current) => current.map((item) => (item.key === key ? { ...item, discount } : item)));
  };

  // An emptied ticket forgets the ticket's discount too.
  const empty = cart.length === 0 && giftCards.length === 0;
  useEffect(() => {
    if (cart.length === 0) setOrderDiscount(undefined);
  }, [cart.length]);

  // ---------------------------------------------------------- the quote
  // What the server will charge: asked again whenever the ticket changes.
  const [quote, setQuote] = useState<PosQuote | null>(null);
  const [quoteKey, setQuoteKey] = useState<string>("");
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const ticketBody = useMemo(
    () => ({
      clientId: selectedClient?.id,
      items: itemsForServer(cart),
      giftCards: giftCardsForServer(giftCards),
      appointmentIds: cart.filter((l) => l.appointmentId).map((l) => l.appointmentId as string),
      ...(rewardId ? { loyaltyRewardId: rewardId } : {}),
      ...(orderDiscount ? { discount: orderDiscount } : {}),
    }),
    [selectedClient?.id, cart, giftCards, rewardId, orderDiscount],
  );
  const bodyKey = JSON.stringify(ticketBody);
  useEffect(() => {
    if (empty || issue) {
      setQuote(null);
      setQuoteKey("");
      setQuoteError(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      apiClient
        .posQuote(ticketBody)
        .then((q) => {
          if (!alive) return;
          setQuote(q);
          setQuoteKey(bodyKey);
          setQuoteError(null);
        })
        .catch((e) => {
          if (!alive) return;
          setQuote(null);
          setQuoteKey("");
          setQuoteError(e instanceof Error ? e.message : "No se pudo calcular el total.");
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyKey, empty, issue]);
  const quoteFresh = !!quote && quoteKey === bodyKey;
  // What is charged: the server's total (shown from the local ticket while it loads).
  const dueCents = quoteFresh ? quote!.total : Math.max(0, ticket.totalCents + giftCardsCents);
  const tenders = tendersOfRows(tenderRows, dueCents);
  // Cash needs the drawer open; card, Bizum and the rest do not (lib/cash-session.ts).
  const drawerIssueKey = empty ? null : drawerProblem(tenders, drawerOpen);
  const tenderIssue = empty ? null : tenderProblem(tenders, dueCents) ?? (drawerIssueKey ? t(drawerIssueKey) : null);
  const invoiceProblem = quoteFresh ? quote!.invoice.problem ?? null : null;

  // The sale's id: the same while the same ticket is retried, a new one
  // for any other ticket (POST /pos/checkout records each id once).
  const attempt = useRef<{ key: string; saleId: string } | null>(null);
  const saleIdFor = (key: string) => {
    if (!attempt.current || attempt.current.key !== key) attempt.current = { key, saleId: newSaleId() };
    return attempt.current.saleId;
  };

  const saveStaffLimit = async () => {
    const value = Number(staffLimitInput);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      toast({ title: "Límite no válido", description: "Escribe un porcentaje entero de 0 a 100.", variant: "destructive" });
      return;
    }
    setSavingSettings(true);
    try {
      const saved = await apiClient.savePosSettings({ maxStaffDiscountPercent: value });
      setMaxStaffDiscount(saved.maxStaffDiscountPercent);
      setStaffLimitInput(String(saved.maxStaffDiscountPercent));
      toast({
        title: "Límite de descuento guardado",
        description:
          saved.maxStaffDiscountPercent === 0
            ? "Solo la propietaria o un encargado pueden aplicar descuentos."
            : `El personal puede descontar hasta un ${saved.maxStaffDiscountPercent} % por línea.`,
      });
      setShowDiscountSettings(false);
    } catch (error: any) {
      toast({ title: "No se pudo guardar el límite", description: error?.message, variant: "destructive" });
    } finally {
      setSavingSettings(false);
    }
  };

  // Appointment payment integration
  const [showAppointmentSelector, setShowAppointmentSelector] = useState(false);
  const selectedAppointments = cart.filter((l) => l.kind === "appointment");

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

  // Owner and managers see the salon; staff, their own sales (the API decides).
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

  // Who did a service sold at the till (commissions): managers pick; staff are themselves.
  useEffect(() => {
    if (!isAdmin) return;
    apiClient
      .getProfessionals()
      .then((list) => setProfessionals((list ?? []).filter((p: any) => p.isActive !== false)))
      .catch(() => setProfessionals([]));
  }, [isAdmin]);

  // Load payments with filters, pagination, sorting
  const loadPayments = async () => {
    try {
      const today = new Date();
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const endOfDay = new Date(startOfDay);
      endOfDay.setHours(23, 59, 59, 999);

      const params: any = {
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
      let paymentsArray: TodayPayment[] = response.payments as unknown as TodayPayment[];

      // The concept is searched here (the API filters the rest).
      if (serviceFilter) {
        const lower = serviceFilter.toLowerCase();
        paymentsArray = paymentsArray.filter((payment) => payment.description?.toLowerCase().includes(lower));
      }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, methodFilter, clientFilter, serviceFilter, currentPage, pageSize, sortBy, sortOrder]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [servicesData, productsData, summaryData] = await Promise.all([
        apiClient.getPosServices().catch(() => []),
        apiClient.getPosSaleProducts().catch(() => []),
        apiClient.getPosDashboard().catch(() => null),
      ]);
      setServices(servicesData || []);
      setProducts(productsData || []);
      setSummary(summaryData);
      await loadPayments();
    } finally {
      setLoading(false);
    }
  };

  const refreshAfterSale = async () => {
    const [summaryData, productsData] = await Promise.all([
      apiClient.getPosDashboard().catch(() => null),
      apiClient.getPosSaleProducts().catch(() => null),
    ]);
    if (summaryData) setSummary(summaryData);
    if (productsData) setProducts(productsData);
    setDrawerKey((k) => k + 1);
    await loadPayments();
  };

  const searchClients = async (query: string) => {
    if (!query) {
      setClients([]);
      return;
    }
    try {
      setClients(await apiClient.getPosClients(query));
    } catch (error) {
      console.error("Failed to search clients:", error);
    }
  };

  const loadAllClients = async () => {
    try {
      setAllClients(await apiClient.getClients());
    } catch (error) {
      console.error("Failed to load clients:", error);
    }
  };

  const addService = (service: Service) => {
    setCart((c) => addLine(c, { kind: "service", serviceId: service.id, name: service.name, unitCents: service.chargeCents }));
  };

  const addProduct = (product: PosSaleProduct) => {
    const inCart = cart.find((l) => l.productId === product.id)?.quantity ?? 0;
    if (product.trackInventory && inCart >= product.quantity) {
      toast({ title: "Sin stock", description: `No quedan más unidades de ${product.name}.`, variant: "destructive" });
      return;
    }
    setCart((c) =>
      addLine(c, {
        kind: "product",
        productId: product.id,
        name: product.name,
        unitCents: product.chargeCents,
        stock: product.trackInventory ? product.quantity : null,
      }),
    );
  };

  const resetTicket = () => {
    setCart([]);
    setGiftCards([]);
    setSelectedClient(null);
    setOrderDiscount(undefined);
    setRewardId("");
    setTenderRows([{ method: "cash", amountText: "" }]);
    attempt.current = null;
  };

  // A discounted ticket is confirmed first, in the panel's dialog.
  const requestCheckout = () => {
    if (empty) return;
    const problem = issue ?? quoteError ?? invoiceProblem ?? tenderIssue;
    if (problem) {
      toast({ title: "Revisa el ticket", description: problem, variant: "destructive" });
      return;
    }
    if (ticket.discountCents > 0) {
      setConfirmingDiscount(true);
      return;
    }
    void processCheckout();
  };

  const processCheckout = async () => {
    if (empty || !quoteFresh) return;
    const payments = tendersForServer(tenders);
    const body = { ...ticketBody, payments };
    const saleId = saleIdFor(JSON.stringify(body));
    try {
      setProcessing(true);
      const result = await apiClient.posCheckout({ ...body, saleId });
      const pts = result?.loyalty;
      const summary =
        `${formatEuros(result.total)}` +
        (result.change ? ` · Cambio ${formatEuros(result.change)}` : "") +
        (result.discount?.total ? ` · Descuento ${formatEuros(result.discount.total)}` : "") +
        (pts?.pointsSpent ? ` · Canjeados ${pts.pointsSpent} puntos` : "") +
        (pts?.pointsEarned ? ` · +${pts.pointsEarned} puntos` : "") +
        (result.giftCards?.some((g) => g.emailSent) ? " · Tarjeta regalo enviada por email" : "");
      // A loyalty reward a visit's issued invoice could not take: the owner
      // credits it by hand (also flagged on the payment, in Pagos). One toast
      // at a time, so the sale's summary goes with the warning.
      const offInvoice = result.loyaltyNotOnInvoice ?? [];
      toast(
        offInvoice.length
          ? {
              variant: "destructive",
              title: t("pos.loyalty_not_on_invoice_title"),
              description: [
                `${t("pos.sale_completed")}: ${summary}.`,
                ...offInvoice.map((off) =>
                  t("pos.loyalty_not_on_invoice", { invoice: off.invoice, amount: formatEuros(off.amountCents) }),
                ),
              ].join(" "),
            }
          : { title: t("pos.sale_completed"), description: summary },
      );
      setReceiptOf({ saleId: result.saleId, email: selectedClient?.email ?? null });
      resetTicket();
      await refreshAfterSale();
    } catch (error: any) {
      // The same ticket sent again keeps its sale id: recorded once.
      toast({
        title: t("pos.checkout_failed"),
        description: error?.message || "Inténtalo de nuevo: si ya se cobró, no se cobrará dos veces.",
        variant: "destructive",
      });
      // The drawer may have been closed from another till meanwhile.
      setDrawerKey((k) => k + 1);
    } finally {
      setProcessing(false);
    }
  };

  const requestQuickSale = (service: Service) => {
    const current = tenderRows.length === 1 ? tenderRows[0].method : "cash";
    setQuickSale({ service, method: QUICK_METHODS.includes(current) ? current : "cash", saleId: newSaleId() });
  };

  // A quick sale does not touch the ticket being built (nor its client).
  const processQuickSale = async () => {
    if (!quickSale) return;
    const closedDrawer = drawerProblem([{ method: quickSale.method, amount: quickSale.service.chargeCents }], drawerOpen);
    if (closedDrawer) {
      toast({ title: t("pos.quick_sale_failed"), description: t(closedDrawer), variant: "destructive" });
      return;
    }
    try {
      setProcessing(true);
      const result = await apiClient.posQuickSale({
        serviceId: quickSale.service.id,
        paymentMethod: quickSale.method,
        clientId: selectedClient?.id,
        saleId: quickSale.saleId,
      });
      const clientName = selectedClient ? `${selectedClient.firstName} ${selectedClient.lastName}` : t("pos.walk_in");
      toast({
        title: t("pos.quick_sale_completed"),
        description: `${clientName} · ${quickSale.service.name} · ${formatEuros(result.total)} (${TENDER_LABELS[quickSale.method]})`,
      });
      setQuickSale(null);
      setReceiptOf({ saleId: result.saleId, email: selectedClient?.email ?? null });
      await refreshAfterSale();
    } catch (error: any) {
      toast({ title: t("pos.quick_sale_failed"), description: error?.message, variant: "destructive" });
    } finally {
      setProcessing(false);
    }
  };

  const afterRefund = async () => {
    // A cash refund comes out of the open drawer.
    setDrawerKey((k) => k + 1);
    await Promise.all([
      apiClient
        .getPosDashboard()
        .then(setSummary)
        .catch(() => {}),
      loadPayments(),
    ]);
  };

  const handleSelectAppointments = (appointments: any[]) => {
    if (appointments.length === 0) return;
    setSelectedClient(appointments[0].client);
    // The appointments replace any chosen before; what else is on the ticket stays.
    setCart((current) => {
      let next = current.filter((l) => l.kind !== "appointment");
      for (const a of appointments) {
        next = addLine(next, {
          kind: "appointment",
          serviceId: a.service?.id,
          appointmentId: a.id,
          name: `${a.service?.name ?? "Cita"} (${a.client.firstName} ${a.client.lastName})`,
          // What is still owed, tax included (a deposit already counts).
          unitCents: a.amountDue ?? a.chargeTotal ?? a.totalAmount,
        });
      }
      return next;
    });
    const due = appointments.reduce((sum: number, a: any) => sum + (a.amountDue ?? a.chargeTotal ?? a.totalAmount), 0);
    toast({
      title: `${appointments.length} ${appointments.length === 1 ? "cita" : "citas"} en el ticket`,
      description: `${appointments.map((a: any) => `${a.client.firstName} ${a.client.lastName}`).join(", ")} — ${formatEuros(due)}`,
    });
  };

  const breakdown = (method: string) => summary?.paymentBreakdown?.find((p) => p.method === method)?.amount ?? 0;
  const checkoutBlocked = empty || processing || !!issue || !quoteFresh || !!quoteError || !!invoiceProblem || !!tenderIssue;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-lg">{t("pos.loading")}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold truncate">{t("pos.title")}</h1>
        <div className="flex flex-wrap items-center gap-3">
          {isAdmin && (
            <button
              type="button"
              onClick={() => setShowDiscountSettings((v) => !v)}
              aria-expanded={showDiscountSettings}
              className="px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
            >
              Descuentos del personal
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowGiftCardSale(true)}
            className="px-4 py-2 rounded-lg border border-purple-300 bg-white text-purple-700 hover:bg-purple-50"
          >
            Vender tarjeta regalo
          </button>
          <button
            type="button"
            onClick={() => setShowAppointmentSelector(true)}
            className="px-4 py-2 rounded-lg bg-purple-600 text-white hover:bg-purple-700"
          >
            {t("pos.select_appointment")}
          </button>
        </div>
      </div>

      {/* The cash drawer: open it with a float, money in or out, close it with the count. */}
      <CashDrawer refreshKey={drawerKey} onStateChange={setDrawerOpen} />

      {isAdmin && showDiscountSettings && (
        <div className="bg-white p-4 rounded-lg shadow max-w-xl">
          <h2 className="text-lg font-semibold mb-1">Descuentos del personal</h2>
          <p className="text-sm text-gray-500 mb-3">
            La propietaria y los encargados pueden descontar siempre. El personal, como mucho este porcentaje en cada
            línea (sumando el descuento de la línea y el del ticket). Con 0, el personal no puede aplicar descuentos.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="pos-staff-discount-limit" className="text-sm text-gray-700">
              Máximo por línea
            </label>
            <input
              id="pos-staff-discount-limit"
              type="number"
              min={0}
              max={100}
              step={1}
              value={staffLimitInput}
              onChange={(e) => setStaffLimitInput(e.target.value)}
              className="w-24 px-3 py-2 border rounded-lg"
            />
            <span className="text-sm text-gray-700">%</span>
            <button
              type="button"
              onClick={saveStaffLimit}
              disabled={savingSettings}
              className="ml-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300"
            >
              {savingSettings ? "Guardando…" : "Guardar"}
            </button>
          </div>
        </div>
      )}

      {showAppointmentSelector && (
        <AppointmentSelector onSelectAppointments={handleSelectAppointments} onClose={() => setShowAppointmentSelector(false)} />
      )}

      {/* Summary: the salon's day for owner and managers, their own sales for staff (the API scopes it). */}
      {summary && (
        <div>
          {summary.ownSalesOnly && <p className="mb-2 text-sm text-gray-600">{t("pos.own_sales_only")}</p>}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-sm text-gray-500">{summary.ownSalesOnly ? "Tus ventas de hoy" : t("pos.today_sales")}</div>
              <div className="text-2xl font-bold text-green-600">{formatEuros(summary.totalSales)}</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-sm text-gray-500">{t("pos.transactions")}</div>
              <div className="text-2xl font-bold">{summary.totalTransactions}</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-sm text-gray-500">{t("pos.refunded")}</div>
              <div className="text-2xl font-bold text-red-600">{formatEuros(summary.refundedAmount)}</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-sm text-gray-500">{t("pos.cash")}</div>
              <div className="text-2xl font-bold text-blue-600">{formatEuros(breakdown("cash"))}</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-sm text-gray-500">{t("pos.card")}</div>
              <div className="text-2xl font-bold text-purple-600">{formatEuros(breakdown("card"))}</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-sm text-gray-500">Bizum</div>
              <div className="text-2xl font-bold text-teal-600">{formatEuros(breakdown("bizum"))}</div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* What the till sells */}
        <div className="lg:col-span-2">
          <div className="bg-white rounded-lg shadow">
            <div className="p-4 border-b flex gap-2" role="tablist">
              {(["services", "products"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={catalogTab === tab}
                  onClick={() => setCatalogTab(tab)}
                  className={`px-3 py-1 rounded-lg text-sm font-semibold ${
                    catalogTab === tab ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  {tab === "services" ? t("pos.services") : t("pos.products")}
                </button>
              ))}
            </div>
            <div className="p-4">
              {catalogTab === "services" ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {services.map((service) => (
                      // Two sibling buttons: a button inside a button is invalid HTML.
                      <div key={service.id} className="border rounded-lg hover:border-blue-500 transition-colors">
                        <button
                          type="button"
                          onClick={() => addService(service)}
                          className="block w-full p-3 text-left hover:bg-blue-50 rounded-t-lg"
                        >
                          <div className="font-medium text-sm truncate">{service.name}</div>
                          <div className="text-lg font-bold text-green-600">{formatEuros(service.chargeCents)}</div>
                          <div className="text-xs text-gray-500">{service.duration} min</div>
                        </button>
                        <div className="px-3 pb-3">
                          <button
                            type="button"
                            onClick={() => requestQuickSale(service)}
                            className="w-full text-xs bg-blue-600 text-white py-1 rounded hover:bg-blue-700 disabled:bg-blue-300"
                            disabled={processing}
                          >
                            {t("pos.quick_sale")}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {services.length === 0 && <div className="text-center py-8 text-gray-500">{t("pos.no_services_available")}</div>}
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {products.map((product) => {
                      const out = product.trackInventory && product.quantity <= 0;
                      return (
                        <button
                          key={product.id}
                          type="button"
                          disabled={out}
                          onClick={() => addProduct(product)}
                          className="p-3 border rounded-lg text-left hover:border-blue-500 hover:bg-blue-50 transition-colors disabled:opacity-50 disabled:hover:bg-white"
                        >
                          <div className="font-medium text-sm truncate">{product.name}</div>
                          <div className="text-lg font-bold text-green-600">{formatEuros(product.chargeCents)}</div>
                          <div className={`text-xs ${out ? "text-red-600" : "text-gray-500"}`}>
                            {product.trackInventory ? (out ? "Sin stock" : `${product.quantity} en stock`) : "Sin control de stock"}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {products.length === 0 && (
                    <div className="text-center py-8 text-gray-500">
                      No hay productos a la venta.{isAdmin ? " Añádelos en Caja y ventas › Productos." : ""}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* The ticket */}
        <div>
          <div className="bg-white rounded-lg shadow">
            <div className="p-4 border-b">
              <h2 className="text-lg font-semibold">{t("pos.cart")}</h2>
            </div>
            <div className="p-4">
              {/* Client */}
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("pos.client_optional")}</label>
                {selectedClient ? (
                  <div className="flex items-center justify-between bg-gray-100 p-2 rounded">
                    <span>
                      {selectedClient.firstName} {selectedClient.lastName}
                    </span>
                    {selectedAppointments.length === 0 && (
                      <button type="button" onClick={() => setSelectedClient(null)} className="text-red-600 text-sm">
                        {t("pos.remove")}
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowClientSearch(!showClientSearch)}
                    className="w-full text-left px-3 py-2 border rounded-lg text-gray-500"
                  >
                    {t("pos.add_client")} · {t("pos.walk_in")}
                  </button>
                )}
                {showClientSearch && !selectedClient && (
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
                            type="button"
                            key={client.id}
                            onClick={() => {
                              setSelectedClient(client);
                              setShowClientSearch(false);
                              setClientSearch("");
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-gray-100"
                          >
                            {client.firstName} {client.lastName}
                            {client.phone && <span className="text-gray-500"> - {client.phone}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Lines: keyed by what they sell, so each control changes only its own line. */}
              <div className="space-y-2 mb-4">
                {cart.map((item, index) => {
                  const line = ticket.lines[index];
                  return (
                    <div key={item.key} className="flex items-start justify-between gap-2 border-b pb-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm break-words">
                          {item.name}
                          {item.kind === "appointment" && <span className="ml-1 text-xs text-purple-700">(cita)</span>}
                        </div>
                        <div className="text-xs text-gray-500">
                          {formatEuros(item.unitCents)} × {item.quantity}
                          {item.kind === "appointment" && " · pendiente de cobro"}
                          {line && line.netCents !== line.grossCents && (
                            <span className="ml-1 text-gray-700">
                              = <span className="line-through">{formatEuros(line.grossCents)}</span> <strong>{formatEuros(line.netCents)}</strong>
                            </span>
                          )}
                        </div>
                        {item.kind === "service" && isAdmin && professionals.length > 0 && (
                          <select
                            aria-label={`Quién hizo ${item.name}`}
                            value={item.professionalId ?? ""}
                            onChange={(e) => setCart((c) => setProfessional(c, item.key, e.target.value || undefined))}
                            className="mt-1 w-full rounded border px-1 py-0.5 text-xs"
                          >
                            <option value="">Lo hizo: quien cobra</option>
                            {professionals.map((p) => (
                              <option key={p.id} value={p.id}>
                                Lo hizo: {p.firstName} {p.lastName}
                              </option>
                            ))}
                          </select>
                        )}
                        {canDiscount && line && (
                          <DiscountEditor
                            value={item.discount}
                            baseCents={line.grossCents}
                            amountCents={line.lineDiscountCents}
                            scope="la línea"
                            onChange={(d) => setLineDiscount(item.key, d)}
                            disabled={processing}
                          />
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {item.kind !== "appointment" && (
                          <>
                            <button
                              type="button"
                              aria-label={`Una unidad menos de ${item.name}`}
                              onClick={() => setCart((c) => setQuantity(c, item.key, item.quantity - 1))}
                              className="w-6 h-6 rounded bg-gray-200 text-gray-600"
                            >
                              −
                            </button>
                            <span className="w-5 text-center">{item.quantity}</span>
                            <button
                              type="button"
                              aria-label={`Una unidad más de ${item.name}`}
                              disabled={item.stock != null && item.quantity >= item.stock}
                              onClick={() => setCart((c) => setQuantity(c, item.key, item.quantity + 1))}
                              className="w-6 h-6 rounded bg-gray-200 text-gray-600 disabled:opacity-40"
                            >
                              +
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          aria-label={`Quitar ${item.name}`}
                          onClick={() => setCart((c) => removeLine(c, item.key))}
                          className="text-red-600 text-sm ml-1"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  );
                })}
                {giftCards.map((card) => (
                  <div key={card.key} className="flex items-start justify-between gap-2 border-b pb-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">Tarjeta regalo</div>
                      <div className="text-xs text-gray-500">
                        {formatEuros(card.amountCents)} · sin IVA
                        {card.recipientName ? ` · para ${card.recipientName}` : ""}
                        {card.recipientEmail ? ` · se envía a ${card.recipientEmail}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Quitar la tarjeta regalo"
                      onClick={() => setGiftCards((g) => g.filter((x) => x.key !== card.key))}
                      className="text-red-600 text-sm"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {empty && <div className="text-center py-4 text-gray-500">{t("pos.cart_empty")}</div>}
              </div>

              {/* Loyalty reward */}
              {loyalty?.member && (
                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm">
                  <div className="mb-1">
                    Puntos: <strong>{loyalty.member.currentPoints}</strong>
                  </div>
                  {loyalty.rewards.some((r) => r.redeemable) ? (
                    <select value={rewardId} onChange={(e) => setRewardId(e.target.value)} className="w-full rounded border px-2 py-1">
                      <option value="">No canjear puntos</option>
                      {loyalty.rewards
                        .filter((r) => r.redeemable)
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name} ({r.pointsCost} puntos)
                          </option>
                        ))}
                    </select>
                  ) : (
                    <div className="text-xs text-gray-600">Aún no le llega para ninguna recompensa.</div>
                  )}
                </div>
              )}

              {/* Discount on the whole ticket */}
              {canDiscount && cart.length > 0 && (
                <div className="mb-3">
                  <DiscountEditor
                    value={orderDiscount}
                    baseCents={ticket.orderBaseCents}
                    amountCents={ticket.orderDiscountCents}
                    scope="el ticket"
                    onChange={setOrderDiscount}
                    disabled={processing}
                  />
                  {!isAdmin && <div className="mt-1 text-xs text-gray-500">Puedes descontar hasta un {maxStaffDiscount} % por línea.</div>}
                </div>
              )}

              {/* Total: the server's */}
              <div className="border-t pt-4">
                {ticket.discountCents > 0 && (
                  <>
                    <div className="flex justify-between text-sm text-gray-600">
                      <span>Subtotal</span>
                      <span>{formatEuros(ticket.subtotalCents + giftCardsCents)}</span>
                    </div>
                    <div className="flex justify-between text-sm text-rose-700">
                      <span>Descuentos</span>
                      <span>−{formatEuros(ticket.discountCents)}</span>
                    </div>
                  </>
                )}
                {quoteFresh && quote!.loyalty && (
                  <div className="flex justify-between text-sm text-amber-700">
                    <span>Descuento por puntos ({quote!.loyalty.rewardName})</span>
                    <span>−{formatEuros(quote!.loyalty.discount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-lg font-bold">
                  <span>{t("pos.total")}</span>
                  <span>{formatEuros(dueCents)}</span>
                </div>
                {quoteFresh && quote!.tax.cents > 0 && (
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>{quote!.tax.note}</span>
                    <span>{formatEuros(quote!.tax.cents)}</span>
                  </div>
                )}
                {!empty && !quoteFresh && !quoteError && !issue && <div className="text-xs text-gray-400">Calculando el total…</div>}
                {(issue || quoteError || invoiceProblem) && (
                  <div role="alert" className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                    {issue ?? quoteError ?? invoiceProblem}
                  </div>
                )}
              </div>

              {/* How she pays */}
              {!empty && (
                <div className="mt-4 mb-4">
                  <TenderPanel
                    dueCents={dueCents}
                    rows={tenderRows}
                    onChange={setTenderRows}
                    canUseWallet={!!selectedClient}
                    disabled={processing}
                  />
                  {tenderIssue && quoteFresh && <div className="mt-2 text-xs text-amber-700">{tenderIssue}</div>}
                </div>
              )}

              <button
                type="button"
                onClick={requestCheckout}
                disabled={checkoutBlocked}
                className={`w-full py-3 rounded-lg font-semibold ${
                  checkoutBlocked ? "bg-gray-300 text-gray-500 cursor-not-allowed" : "bg-green-600 text-white hover:bg-green-700"
                }`}
              >
                {processing
                  ? t("pos.processing")
                  : empty
                    ? t("pos.cart_empty")
                    : `Cobrar ${formatEuros(dueCents)}`}
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
                {/* The server's statuses: the old options (succeeded,
                    processing...) do not exist and are now a 400. */}
                {Object.entries(PAYMENT_STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
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
                <option value="bizum">Bizum</option>
                <option value="wallet">
                  {t("payments.payment_methods.wallet")}
                </option>
                <option value="gift_card">Tarjeta regalo</option>
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
                      {formatEuros(payment.amount)}
                    </td>
                    <td className="px-4 py-2 text-sm text-gray-500">
                      {methodLabel(payment.method)}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                          payment.status === "paid"
                            ? "bg-green-100 text-green-800"
                            : payment.status === "pending"
                              ? "bg-yellow-100 text-yellow-800"
                              : payment.status === "refunded"
                                ? "bg-gray-100 text-gray-800"
                                : "bg-red-100 text-red-800"
                        }`}
                      >
                        {payment.status === "paid" && (payment.refundedAmount ?? 0) > 0
                          ? "Pagado · devuelto en parte"
                          : statusLabel(payment.status)}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-2">
                        {refundableCents(payment) > 0 && (
                          <button
                            onClick={() => setPendingVoid(payment)}
                            className="text-red-600 hover:text-red-800 text-sm"
                          >
                            Devolver
                          </button>
                        )}
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

      <ConfirmDialog
        open={confirmingDiscount}
        title={`¿Cobrar ${formatEuros(dueCents)} con un descuento de ${formatEuros(ticket.discountCents)}?`}
        description={
          <>
            Subtotal {formatEuros(ticket.subtotalCents + giftCardsCents)}, descuento {formatEuros(ticket.discountCents)}.
            {discountReasons.length > 0 && <> Motivo: {discountReasons.join(" · ")}.</>} El descuento queda registrado a tu
            nombre.
          </>
        }
        confirmLabel="Cobrar con descuento"
        cancelLabel="Volver"
        loading={processing}
        onCancel={() => setConfirmingDiscount(false)}
        onConfirm={() => {
          setConfirmingDiscount(false);
          void processCheckout();
        }}
      />

      <ConfirmDialog
        open={!!quickSale}
        title={quickSale ? `¿Venta rápida de ${formatEuros(quickSale.service.chargeCents)}?` : ""}
        description={
          quickSale ? (
            <div className="space-y-2">
              <p>
                {quickSale.service.name} · {selectedClient ? `${selectedClient.firstName} ${selectedClient.lastName}` : t("pos.walk_in")}
                . El ticket que estás preparando no cambia.
              </p>
              <label className="flex items-center gap-2 text-sm">
                Forma de pago
                <select
                  value={quickSale.method}
                  onChange={(e) => setQuickSale({ ...quickSale, method: e.target.value as TenderMethod })}
                  className="rounded border px-2 py-1"
                >
                  {QUICK_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {TENDER_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null
        }
        confirmLabel="Cobrar"
        cancelLabel="Cancelar"
        loading={processing}
        onCancel={() => setQuickSale(null)}
        onConfirm={() => void processQuickSale()}
      />

      {showGiftCardSale && (
        <GiftCardSaleDialog
          onAdd={(card) => setGiftCards((g) => [...g, { ...card, key: newSaleId() }])}
          onClose={() => setShowGiftCardSale(false)}
        />
      )}

      {receiptOf && (
        <SaleReceipt saleId={receiptOf.saleId} clientEmail={receiptOf.email} canEmail={isAdmin} onClose={() => setReceiptOf(null)} />
      )}

      <RefundPaymentDialog payment={pendingVoid} onClose={() => setPendingVoid(null)} onRefunded={() => void afterRefund()} />
    </div>
  );
}
