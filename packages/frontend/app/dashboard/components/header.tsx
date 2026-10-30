"use client";

import { BadgeEuro, ChevronDown, LogOut, Menu, Search, Settings, ShieldCheck, User } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { NotificationBell } from "./notification-bell";
import { LanguageSwitcher } from "./language-switcher";
import { TenantIdentityBadge } from "./tenant-identity-badge";
import { getCurrentUser } from "@/lib/utils";
import { isManager } from "@/lib/dashboard-nav";
import { signOut } from "@/lib/sign-out";
import { useTranslations } from "@/lib/use-translation";

const MENU_ITEM =
  "flex items-center gap-2 px-3 py-2 text-sm text-gray-700 rounded-md outline-none cursor-pointer data-[highlighted]:bg-violet-50 data-[highlighted]:text-violet-900";

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
  // Read after mount: the server has no localStorage and renders "User", so
  // a first client render with the email would not hydrate.
  const [currentUser, setCurrentUser] = useState<ReturnType<
    typeof getCurrentUser
  > | null>(null);
  useEffect(() => {
    setCurrentUser(getCurrentUser());
  }, []);
  const t = useTranslations();
  const manager = isManager(currentUser?.role);

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
          {/* The account menu: plan, security and signing out. */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="flex items-center space-x-2 rounded-full sm:rounded-lg sm:pr-2 hover:bg-gray-100 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
                aria-label={t("nav.account")}
              >
                <User className="h-7 w-7 sm:h-8 sm:w-8 rounded-full bg-purple-200 p-1 text-purple-700 flex-shrink-0" />
                <span className="hidden sm:inline text-sm font-medium text-gray-700 truncate max-w-[160px]">
                  {currentUser?.email || "User"}
                </span>
                <ChevronDown className="hidden sm:inline h-4 w-4 text-gray-500" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={6}
                className="z-50 min-w-[220px] rounded-lg border border-gray-200 bg-white p-1 shadow-lg"
              >
                <DropdownMenu.Label className="px-3 py-2 text-xs text-gray-500 truncate">
                  {currentUser?.email || t("nav.account")}
                </DropdownMenu.Label>
                {manager && (
                  <DropdownMenu.Item asChild>
                    <Link href="/dashboard/billing" className={MENU_ITEM}>
                      <BadgeEuro className="h-4 w-4" />
                      {t("nav.billing")}
                    </Link>
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item asChild>
                  <Link href="/dashboard/settings/seguridad" className={MENU_ITEM}>
                    <ShieldCheck className="h-4 w-4" />
                    {t("nav.security")}
                  </Link>
                </DropdownMenu.Item>
                {manager && (
                  <DropdownMenu.Item asChild>
                    <Link href="/dashboard/settings" className={MENU_ITEM}>
                      <Settings className="h-4 w-4" />
                      {t("nav.settings")}
                    </Link>
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Separator className="my-1 h-px bg-gray-100" />
                <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void signOut()}>
                  <LogOut className="h-4 w-4" />
                  {t("nav.logout")}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
    </header>
  );
}
