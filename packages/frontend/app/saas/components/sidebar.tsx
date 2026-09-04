"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  Home,
  Building2,
  Users,
  BarChart2,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  X,
  Bug,
} from "lucide-react";
import apiClient from "@/lib/api";
import { removeToken } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

interface SaasSidebarProps {
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

export function SaasSidebar({
  collapsed,
  onToggle,
  showCloseButton = false,
}: SaasSidebarProps) {
  const t = useTranslations();
  const pathname = usePathname() || "";
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  // When rendering as a mobile drawer, force the sidebar to its
  // expanded width regardless of the desktop `collapsed` prop.
  const forceExpanded = showCloseButton;
  const effectiveCollapsed = !forceExpanded && collapsed;

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await apiClient.logout();
    } catch (error) {
      console.error("Error logging out:", error);
    } finally {
      removeToken();
      if (typeof window !== "undefined") {
        localStorage.removeItem("user");
        document.cookie = "saas_user=; path=/; max-age=0";
      }
      window.location.href = "/saas/login";
    }
  };

  const navItems = [
    { href: "/saas", icon: Home, labelKey: "saas.nav.overview", exact: true },
    { href: "/saas/tenants", icon: Building2, labelKey: "saas.nav.salons" },
    { href: "/saas/users", icon: Users, labelKey: "saas.nav.users" },
    { href: "/saas/analytics", icon: BarChart2, labelKey: "saas.nav.analytics" },
    { href: "/saas/bug-reports", icon: Bug, labelKey: "saas.nav.bugReports" },
    { href: "/saas/settings", icon: Settings, labelKey: "saas.nav.settings" },
  ];

  const isActive = (item: { href: string; exact?: boolean }) => {
    if (item.exact) return pathname === item.href;
    return pathname.startsWith(item.href);
  };

  return (
    <aside
      className={
        "h-full bg-slate-900 flex flex-col transition-all duration-300 " +
        (effectiveCollapsed ? "w-16" : "w-64")
      }
    >
      <div
        className={
          "border-b border-slate-700 transition-all duration-300 " +
          (effectiveCollapsed ? "p-2" : "p-4")
        }
      >
        {effectiveCollapsed ? (
          <div className="flex justify-center">
            <button
              onClick={onToggle}
              className="p-2 text-white hover:bg-slate-800 rounded-lg transition-colors"
              title={t("saas.expandSidebar")}
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        ) : showCloseButton ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-xl font-bold text-white">KiraSaaS</h1>
              <button
                onClick={onToggle}
                className="p-2 text-white hover:bg-slate-800 rounded transition-colors"
                title={t("common.closeSidebar")}
                aria-label={t("common.closeSidebar")}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-slate-400">{t("saas.platformAdmin")}</p>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-xl font-bold text-white">KiraSaaS</h1>
              <button
                onClick={onToggle}
                className="p-1 text-white hover:bg-slate-800 rounded transition-colors"
                title={t("saas.collapseSidebar")}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-slate-400">{t("saas.platformAdmin")}</p>
          </>
        )}
      </div>

      <nav
        className={
          "flex-1 transition-all duration-300 " +
          (effectiveCollapsed ? "p-2" : "p-4 pr-0")
        }
      >
        <ul className="space-y-2">
          {navItems.map((item) => {
            const label = t(item.labelKey);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={
                    "flex items-center rounded-l-lg w-full transition-all duration-200 " +
                    (effectiveCollapsed ? "justify-center p-3" : "p-3") +
                    " " +
                    (isActive(item)
                      ? "bg-white text-slate-900 rounded-r-none"
                      : "text-slate-300 hover:text-white hover:bg-slate-800 hover:-translate-x-3 hover:rounded-lg rounded-r-none")
                  }
                  title={effectiveCollapsed ? label : undefined}
                >
                  <item.icon className={"w-5 h-5 " + (effectiveCollapsed ? "" : "mr-3")} />
                  {!effectiveCollapsed && <span>{label}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div
        className={
          "border-t border-slate-700 transition-all duration-300 " +
          (effectiveCollapsed ? "p-2" : "p-4 pr-0")
        }
      >
        <button
          onClick={handleLogout}
          disabled={isLoggingOut}
          className={
            "flex items-center rounded-l-lg w-full disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 " +
            (effectiveCollapsed ? "justify-center p-3" : "p-3") +
            " text-slate-300 hover:text-white hover:bg-slate-800 hover:-translate-x-3 hover:rounded-lg rounded-r-none"
          }
          title={effectiveCollapsed ? t("saas.logout") : undefined}
        >
          <LogOut className={"w-5 h-5 " + (effectiveCollapsed ? "" : "mr-3")} />
          {!effectiveCollapsed && (
            <span>{isLoggingOut ? t("common.loading") : t("saas.logout")}</span>
          )}
        </button>
      </div>
    </aside>
  );
}