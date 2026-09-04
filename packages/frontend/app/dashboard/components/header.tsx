"use client";

import { Search, User, Menu } from "lucide-react";
import { useMemo } from "react";
import { NotificationBell } from "./notification-bell";
import { LanguageSwitcher } from "./language-switcher";
import { TenantIdentityBadge } from "./tenant-identity-badge";
import { getCurrentUser } from "@/lib/utils";

interface DashboardHeaderProps {
  onToggleSidebar?: () => void;
  /**
   * If true, the hamburger button only appears below the `md`
   * breakpoint. Used when the dashboard sidebar is desktop-only
   * (collapse/expand lives inside the sidebar itself) and the
   * header button is only for opening the mobile drawer.
   */
  mobileOnly?: boolean;
}

export function DashboardHeader({
  onToggleSidebar,
  mobileOnly = false,
}: DashboardHeaderProps) {
  const currentUser = useMemo(() => getCurrentUser(), []);

  return (
    <header className="bg-white/90 backdrop-blur-md border-b border-gray-200 px-4 py-3 sm:px-6 sticky top-0 z-10">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center min-w-0 space-x-2 sm:space-x-4">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className={`p-2 -ml-2 rounded-md text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors flex-shrink-0 ${
                mobileOnly ? "md:hidden" : ""
              }`}
              title="Toggle sidebar"
            >
              <Menu className="h-5 w-5" />
            </button>
          )}
          <h2 className="text-lg sm:text-xl font-semibold text-gray-800 truncate">
            Dashboard
          </h2>
          <div className="relative hidden md:block">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="Search..."
              className="block w-64 pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-purple-500 focus:border-purple-500 sm:text-sm"
            />
          </div>
        </div>

        <div className="flex items-center flex-shrink-0 gap-2 sm:gap-3">
          <TenantIdentityBadge />
          <LanguageSwitcher />
          <NotificationBell />
          <div className="flex items-center space-x-2">
            <User className="h-7 w-7 sm:h-8 sm:w-8 rounded-full bg-purple-200 p-1 text-purple-700 flex-shrink-0" />
            <span className="hidden sm:inline text-sm font-medium text-gray-700 truncate max-w-[160px]">
              {currentUser?.email || "User"}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
