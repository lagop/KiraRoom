"use client";

import { Menu, Bell, Search } from "lucide-react";
import { LanguageSwitcher } from "./language-switcher";
import { useTranslations } from "@/lib/use-translation";

interface SaasHeaderProps {
  onToggleSidebar: () => void;
  /**
   * If true, the hamburger button only appears below the `md`
   * breakpoint. Used when the SaaS sidebar is desktop-only
   * (collapse/expand lives inside the sidebar itself) and the
   * header button is only for opening the mobile drawer.
   */
  mobileOnly?: boolean;
}

export function SaasHeader({
  onToggleSidebar,
  mobileOnly = false,
}: SaasHeaderProps) {
  const t = useTranslations();
  return (
    <header className="bg-white border-b border-gray-200 px-4 py-3 sm:px-6 sm:py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center min-w-0 gap-2 sm:space-x-4">
          <button
            onClick={onToggleSidebar}
            className={`p-2 -ml-2 rounded-md text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors flex-shrink-0 ${
              mobileOnly ? "md:hidden" : "lg:hidden"
            }`}
            aria-label={t("saas.toggleSidebar")}
            title="Toggle sidebar"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="relative hidden md:block">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
            <input
              type="text"
              placeholder={t("saas.searchPlaceholder")}
              className="pl-10 pr-4 py-2 border border-gray-200 rounded-lg w-48 sm:w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>
        <div className="flex items-center flex-shrink-0 gap-2 sm:gap-3">
          <LanguageSwitcher />
          <button className="relative p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors" aria-label={t("saas.notifications")}>
            <Bell className="w-5 h-5" />
            <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full"></span>
          </button>
          <div className="flex items-center space-x-2 sm:space-x-3">
            <div className="w-8 h-8 bg-slate-900 rounded-full flex items-center justify-center flex-shrink-0">
              <span className="text-white text-sm font-medium">SA</span>
            </div>
            <div className="hidden md:block">
              <p className="text-sm font-medium text-gray-900 truncate max-w-[160px]">{t("saas.adminRole")}</p>
              <p className="text-xs text-gray-500">{t("saas.platformOwner")}</p>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
