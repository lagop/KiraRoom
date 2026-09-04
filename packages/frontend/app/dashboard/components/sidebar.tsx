"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Home,
  Users,
  Scissors,
  Calendar,
  BarChart2,
  Settings,
  Store,
  Repeat,
  FileText,
  Bug,
  ScrollText,
  Calculator,
  LogOut,
  CreditCard,
  ShoppingCart,
  DollarSign,
  Gift,
  Wallet,
  Tag,
  Mail,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Star,
  MessageCircle,
  Sliders,
  X,
} from "lucide-react";
import apiClient, { removeToken } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";
import { getCurrentUser } from "@/lib/utils";
import { BugReportModal } from "./bug-report-modal";
import { ProBadge } from "@/components/ProBadge";

interface DashboardSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  /**
   * Mobile drawer variant — true when the sidebar is rendered as an
   * overlay inside the mobile drawer (<md). Renders a fixed-width
   * sidebar with an explicit close button instead of the collapse
   * toggle used in desktop mode.
   */
  showCloseButton?: boolean;
}

export function DashboardSidebar({
  collapsed,
  onToggle,
  showCloseButton = false,
}: DashboardSidebarProps) {
  const pathname = usePathname() || "";
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const { toast } = useToast();
  const t = useTranslations();
  // When rendering as a mobile drawer, force the sidebar to its
  // expanded width regardless of the desktop `collapsed` prop.
  const forceExpanded = showCloseButton;
  const effectiveCollapsed = !forceExpanded && collapsed;

  // Current user info — read from localStorage after mount only.
  // `getCurrentUser()` returns null on the server (no `window`), so
  // initializing from it directly would make the first client render
  // include menu items the server didn't, triggering a hydration
  // mismatch (React detects the extra <circle> inside the icon SVGs).
  // Initialize to null (matches server) and populate post-mount.
  const [currentUser, setCurrentUser] = useState<ReturnType<
    typeof getCurrentUser
  > | null>(null);
  useEffect(() => {
    setCurrentUser(getCurrentUser());
  }, [pathname]);
  const isAdminOrOwner =
    currentUser?.role === "admin" || currentUser?.role === "owner";
  const isStaff = currentUser?.role === "staff";

  const settingsOpen =
    pathname === "/dashboard/settings" ||
    pathname.startsWith("/dashboard/settings/") ||
    pathname.startsWith("/dashboard/billing/invoices");
  const onSettingsIndex = pathname === "/dashboard/settings";
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  useEffect(() => {
    if (settingsOpen) setIsSettingsOpen(true);
  }, [settingsOpen]);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await apiClient.logout();
    } catch (error) {
      console.error("Error logging out:", error);
    } finally {
      removeToken();
      window.location.href = "/login";
    }
  };

  return (
    <aside
      className={`h-full bg-violet-950 flex flex-col transition-all duration-300 ${
        effectiveCollapsed ? "w-16" : "w-64"
      }`}
    >
      <div
        className={`border-b border-violet-800 transition-all duration-300 ${
          effectiveCollapsed ? "p-1.5" : "p-3"
        }`}
      >
        {effectiveCollapsed ? (
          <div className="flex justify-center">
            <button
              onClick={onToggle}
              className="p-2 text-white hover:bg-violet-800 rounded-lg transition-colors"
              title={t("common.expandSidebar")}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        ) : showCloseButton ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-xl font-bold text-white">{t("nav.appName")}</h1>
              <button
                onClick={onToggle}
                className="p-2 text-white hover:bg-violet-800 rounded transition-colors"
                title={t("common.closeSidebar")}
                aria-label={t("common.closeSidebar")}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-xl font-bold text-white">{t("nav.appName")}</h1>
              <button
                onClick={onToggle}
                className="p-1 text-white hover:bg-violet-800 rounded transition-colors"
                title={t("common.collapseSidebar")}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </div>

      <nav
        className={`flex-1 transition-all duration-300 ${
          effectiveCollapsed ? "p-1" : "p-2 pr-0"
        }`}
      >
        <ul className="space-y-0.5">
          <li>
            <Link
              href="/dashboard"
              className={`flex items-center rounded-l-lg w-full transition-all duration-200 
                ${
                effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
              } ${
                pathname === "/dashboard"
                  ? "bg-white text-violet-950 rounded-r-none"
                  : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
              }`}
              title={effectiveCollapsed ? t("nav.dashboard") : undefined}
            >
              <Home className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
              {!collapsed && (
                <span suppressHydrationWarning>{t("nav.dashboard")}</span>
              )}
            </Link>
          </li>
          <li>
            <Link
              href="/dashboard/clients"
              className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
              } ${
                pathname.startsWith("/dashboard/clients")
                  ? "bg-white text-violet-950 rounded-r-none"
                  : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
              }`}
              title={effectiveCollapsed ? t("nav.clients") : undefined}
            >
              <Users className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
              {!collapsed && (
                <span suppressHydrationWarning>{t("nav.clients")}</span>
              )}
            </Link>
          </li>
          {/* Professionals - Admin/Owner only */}
          {isAdminOrOwner && (
            <li>
              <Link
                href="/dashboard/professionals"
                className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                  effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
                } ${
                  pathname.startsWith("/dashboard/professionals")
                    ? "bg-white text-violet-950 rounded-r-none"
                    : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                }`}
                title={effectiveCollapsed ? t("nav.professionals") : undefined}
              >
                <Scissors className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning>{t("nav.professionals")}</span>
                )}
              </Link>
            </li>
          )}
          {/* Services - Admin/Owner only */}
          {isAdminOrOwner && (
            <li>
              <Link
                href="/dashboard/services"
                className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                  effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
                } ${
                  pathname.startsWith("/dashboard/services")
                    ? "bg-white text-violet-950 rounded-r-none"
                    : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                }`}
                title={effectiveCollapsed ? t("nav.services") : undefined}
              >
                <Scissors className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning>{t("nav.services")}</span>
                )}
              </Link>
            </li>
          )}
          <li>
            <Link
              href="/dashboard/appointments"
              className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
              } ${
                pathname.startsWith("/dashboard/appointments")
                  ? "bg-white text-violet-950 rounded-r-none"
                  : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
              }`}
              title={effectiveCollapsed ? t("nav.appointments") : undefined}
            >
              <Calendar className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
              {!collapsed && (
                <span suppressHydrationWarning>{t("nav.appointments")}</span>
              )}
            </Link>
          </li>
          {/* Payments - Admin/Owner only */}
          {isAdminOrOwner && (
            <li>
              <Link
                href="/dashboard/payments"
                className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                  effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
                } ${
                  pathname.startsWith("/dashboard/payments")
                    ? "bg-white text-violet-950 rounded-r-none"
                    : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                }`}
                title={effectiveCollapsed ? t("nav.payments") : undefined}
              >
                <CreditCard className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning>{t("nav.payments")}</span>
                )}
              </Link>
            </li>
          )}
          <li>
            <Link
              href="/dashboard/pos"
              className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
              } ${
                pathname.startsWith("/dashboard/pos")
                  ? "bg-white text-violet-950 rounded-r-none"
                  : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
              }`}
              title={effectiveCollapsed ? t("nav.pos") : undefined}
            >
              <ShoppingCart className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
              {!collapsed && (
                <span suppressHydrationWarning>{t("nav.pos")}</span>
              )}
            </Link>
          </li>
          {/* Commissions - Admin/Owner only */}
          {isAdminOrOwner && (
            <li>
              <Link
                href="/dashboard/commissions"
                className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                  effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
                } ${
                  pathname.startsWith("/dashboard/commissions")
                    ? "bg-white text-violet-950 rounded-r-none"
                    : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                }`}
                title={effectiveCollapsed ? t("nav.commissions") : undefined}
              >
                <DollarSign className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning>{t("nav.commissions")}</span>
                )}
              </Link>
            </li>
          )}
          {/* Loyalty - Admin/Owner only */}
          {isAdminOrOwner && (
            <li>
              <Link
                href="/dashboard/loyalty"
                className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                  effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
                } ${
                  pathname.startsWith("/dashboard/loyalty")
                    ? "bg-white text-violet-950 rounded-r-none"
                    : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                }`}
                title={effectiveCollapsed ? t("nav.loyalty") : undefined}
              >
                <Gift className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning>{t("nav.loyalty")}</span>
                )}
              </Link>
            </li>
          )}
          {/* Email Campaigns - Admin/Owner only */}
          {isAdminOrOwner && (
            <li>
              <Link
                href="/dashboard/email-campaigns"
                className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                  effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
                } ${
                  pathname.startsWith("/dashboard/email-campaigns")
                    ? "bg-white text-violet-950 rounded-r-none"
                    : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                }`}
                title={effectiveCollapsed ? t("nav.email_campaigns") : undefined}
              >
                <Mail className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning>
                    {t("nav.email_campaigns")}
                  </span>
                )}
              </Link>
            </li>
          )}
          {/* Promotions - Admin/Owner only */}
          {isAdminOrOwner && (
            <li>
              <Link
                href="/dashboard/promotions"
                className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                  effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
                } ${
                  pathname.startsWith("/dashboard/promotions")
                    ? "bg-white text-violet-950 rounded-r-none"
                    : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                }`}
                title={effectiveCollapsed ? t("nav.promotions") : undefined}
              >
                <Tag className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning>{t("nav.promotions")}</span>
                )}
              </Link>
            </li>
          )}
          {/* Gift Cards - Admin/Owner only */}
          {isAdminOrOwner && (
            <li>
              <Link
                href="/dashboard/gift-cards"
                className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                  effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
                } ${
                  pathname.startsWith("/dashboard/gift-cards")
                    ? "bg-white text-violet-950 rounded-r-none"
                    : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                }`}
                title={effectiveCollapsed ? "Gift cards" : undefined}
              >
                <Wallet className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning className="flex-1">
                    Gift cards
                  </span>
                )}
                {!collapsed && <ProBadge />}
              </Link>
            </li>
          )}
          {/* Analytics - Admin/Owner only */}
          {isAdminOrOwner && (
            <li>
              <Link
                href="/dashboard/analytics"
                className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                  effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
                } ${
                  pathname.startsWith("/dashboard/analytics")
                    ? "bg-white text-violet-950 rounded-r-none"
                    : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                }`}
                title={effectiveCollapsed ? t("nav.analytics") : undefined}
              >
                <BarChart2 className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning>{t("nav.analytics")}</span>
                )}
              </Link>
            </li>
          )}
          {/* Reviews - Admin/Owner only */}
          {isAdminOrOwner && (
            <li>
              <Link
                href="/dashboard/reviews"
                className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                  effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
                } ${
                  pathname.startsWith("/dashboard/reviews")
                    ? "bg-white text-violet-950 rounded-r-none"
                    : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                }`}
                title={effectiveCollapsed ? t("nav.reviews") : undefined}
              >
                <Star className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning>{t("nav.reviews")}</span>
                )}
              </Link>
            </li>
          )}
          {/* WhatsApp Campaigns - Admin/Owner only */}
          {isAdminOrOwner && (
            <li>
              <Link
                href="/dashboard/marketing/whatsapp"
                className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                  effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
                } ${
                  pathname.startsWith("/dashboard/marketing/whatsapp")
                    ? "bg-white text-violet-950 rounded-r-none"
                    : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                }`}
                title={effectiveCollapsed ? t("nav.whatsapp_campaigns") : undefined}
              >
                <MessageCircle className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning className="flex-1">
                    {t("nav.whatsapp_campaigns")}
                  </span>
                )}
                {!collapsed && <ProBadge />}
              </Link>
            </li>
          )}
        </ul>
      </nav>

      <div
        className={`border-t border-violet-800 bg-violet-950 transition-all duration-300 ${
          effectiveCollapsed ? "p-1" : "p-2 pr-0"
        }`}
      >
        {/* Settings dropdown - Admin/Owner only */}
        {isAdminOrOwner && (
          <div>
            <div
              className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
                effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
              } ${
                settingsOpen
                  ? "bg-white text-violet-950 rounded-r-none"
                  : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
              }`}
            >
              <Link
                href="/dashboard/settings"
                className={`flex items-center flex-1 ${
                  effectiveCollapsed ? "justify-center" : ""
                } ${
                  onSettingsIndex
                    ? "font-semibold"
                    : ""
                }`}
                title={effectiveCollapsed ? t("nav.settings") : undefined}
              >
                <Settings className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
                {!collapsed && (
                  <span suppressHydrationWarning>{t("nav.settings")}</span>
                )}
              </Link>
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen((v) => !v)}
                  aria-expanded={isSettingsOpen}
                  aria-label={t("nav.settings")}
                  className="ml-2 p-1 rounded hover:bg-violet-300/40"
                >
                  <ChevronDown
                    className={`w-4 h-4 transition-transform duration-200 ${
                      isSettingsOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
              )}
            </div>
            {isSettingsOpen && !collapsed && (
              <ul className="mt-1 space-y-1">
                <li>
                  <Link
                    href="/dashboard/settings"
                    className={`flex items-center pl-9 pr-3 py-2 rounded-l-lg w-full transition-all duration-200 ${
                      onSettingsIndex
                        ? "bg-white text-violet-950 rounded-r-none"
                        : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                    }`}
                    title="Generales"
                  >
                    <Sliders className="w-4 h-4 mr-3" />
                    <span suppressHydrationWarning>Generales</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/dashboard/settings/salon"
                    className={`flex items-center pl-9 pr-3 py-2 rounded-l-lg w-full transition-all duration-200 ${
                      pathname.startsWith("/dashboard/settings/salon")
                        ? "bg-white text-violet-950 rounded-r-none"
                        : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                    }`}
                    title="Datos del salón"
                  >
                    <Store className="w-4 h-4 mr-3" />
                    <span suppressHydrationWarning>Datos del salón</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/dashboard/settings/rebooking"
                    className={`flex items-center pl-9 pr-3 py-2 rounded-l-lg w-full transition-all duration-200 ${
                      pathname.startsWith("/dashboard/settings/rebooking")
                        ? "bg-white text-violet-950 rounded-r-none"
                        : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                    }`}
                    title={t("rebooking.settings.title")}
                  >
                    <Repeat className="w-4 h-4 mr-3" />
                    <span suppressHydrationWarning className="flex-1">
                      {t("rebooking.settings.title")}
                    </span>
                    <ProBadge />
                  </Link>
                </li>
                <li>
                  <Link
                    href="/dashboard/settings/fiscal"
                    className={`flex items-center pl-9 pr-3 py-2 rounded-l-lg w-full transition-all duration-200 ${
                      pathname.startsWith("/dashboard/settings/fiscal")
                        ? "bg-white text-violet-950 rounded-r-none"
                        : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                    }`}
                    title={t("invoices.fiscalSettings.title")}
                  >
                    <ScrollText className="w-4 h-4 mr-3" />
                    <span suppressHydrationWarning className="flex-1">
                      {t("invoices.fiscalSettings.title")}
                    </span>
                    <ProBadge />
                  </Link>
                </li>
                <li>
                  <Link
                    href="/dashboard/settings/accounting"
                    className={`flex items-center pl-9 pr-3 py-2 rounded-l-lg w-full transition-all duration-200 ${
                      pathname.startsWith("/dashboard/settings/accounting")
                        ? "bg-white text-violet-950 rounded-r-none"
                        : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                    }`}
                    title={t("accounting.title")}
                  >
                    <Calculator className="w-4 h-4 mr-3" />
                    <span suppressHydrationWarning className="flex-1">
                      {t("accounting.title")}
                    </span>
                    <ProBadge />
                  </Link>
                </li>
                <li>
                  <Link
                    href="/dashboard/billing/invoices"
                    className={`flex items-center pl-9 pr-3 py-2 rounded-l-lg w-full transition-all duration-200 ${
                      pathname.startsWith("/dashboard/billing/invoices")
                        ? "bg-white text-violet-950 rounded-r-none"
                        : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                    }`}
                    title={t("invoices.title")}
                  >
                    <FileText className="w-4 h-4 mr-3" />
                    <span suppressHydrationWarning>{t("invoices.title")}</span>
                  </Link>
                </li>
                <li>
                  <Link
                    href="/dashboard/settings/channels"
                    className={`flex items-center pl-9 pr-3 py-2 rounded-l-lg w-full transition-all duration-200 ${
                      pathname.startsWith("/dashboard/settings/channels")
                        ? "bg-white text-violet-950 rounded-r-none"
                        : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
                    }`}
                    title={t("billing.channels.title")}
                  >
                    <MessageCircle className="w-4 h-4 mr-3" />
                    <span suppressHydrationWarning className="flex-1">
                      {t("billing.channels.title")}
                    </span>
                    <ProBadge />
                  </Link>
                </li>
              </ul>
            )}
          </div>
        )}
        {/* Invoices - staff (no admin/owner-only settings) */}
        {!isAdminOrOwner && (
          <Link
            href="/dashboard/billing/invoices"
            className={`flex items-center rounded-l-lg w-full transition-all duration-200 ${
              effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
            } ${
              pathname.startsWith("/dashboard/billing/invoices")
                ? "bg-white text-violet-950 rounded-r-none"
                : "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
            }`}
            title={effectiveCollapsed ? t("invoices.title") : undefined}
          >
            <FileText className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
            {!collapsed && (
              <span suppressHydrationWarning>{t("invoices.title")}</span>
            )}
          </Link>
        )}
        <button
          onClick={() => setShowBugReport(true)}
          className={`flex items-center rounded-l-lg w-full mt-1 transition-all duration-200 ${
            effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
          } ${"text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"}`}
                  title={effectiveCollapsed ? "Reportar un bug" : undefined}
        >
          <Bug className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
          {!collapsed && (
            <span suppressHydrationWarning>Reportar bug</span>
          )}
        </button>
        <button
          onClick={handleLogout}
          disabled={isLoggingOut}
          className={`flex items-center rounded-l-lg w-full mt-1 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 ${
            effectiveCollapsed ? "justify-center py-2" : "py-2 px-3"
          } ${"text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none"}`}
          title={effectiveCollapsed ? t("nav.logout") : undefined}
        >
          <LogOut className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
          {!collapsed && (
            <span suppressHydrationWarning>
              {isLoggingOut ? t("common.loading") : t("nav.logout")}
            </span>
          )}
        </button>
      </div>
      <BugReportModal open={showBugReport} onClose={() => setShowBugReport(false)} />
    </aside>
  );
}
