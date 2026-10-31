"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import {
  BadgeEuro,
  BarChart2,
  Bug,
  Calculator,
  Calendar,
  CalendarOff,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  DollarSign,
  FileText,
  Gift,
  Globe,
  Home,
  Hourglass,
  LogOut,
  LucideIcon,
  Mail,
  Megaphone,
  MessageCircle,
  QrCode,
  Receipt,
  Repeat,
  Scissors,
  ScrollText,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Sliders,
  Star,
  Store,
  Tag,
  UserCog,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import { getCurrentUser } from "@/lib/utils";
import { NavGroup, NavLink, activeGroup, isActive, navFor } from "@/lib/dashboard-nav";
import { signOut } from "@/lib/sign-out";
import { BugReportModal } from "./bug-report-modal";
import { ProBadge } from "@/components/ProBadge";

const ICONS: Record<string, LucideIcon> = {
  home: Home,
  calendar: Calendar,
  "calendar-off": CalendarOff,
  users: Users,
  hourglass: Hourglass,
  scissors: Scissors,
  "user-cog": UserCog,
  dollar: DollarSign,
  receipt: Receipt,
  cart: ShoppingCart,
  card: CreditCard,
  file: FileText,
  wallet: Wallet,
  megaphone: Megaphone,
  mail: Mail,
  message: MessageCircle,
  tag: Tag,
  gift: Gift,
  star: Star,
  qr: QrCode,
  chart: BarChart2,
  settings: Settings,
  sliders: Sliders,
  euro: BadgeEuro,
  store: Store,
  globe: Globe,
  shield: ShieldCheck,
  repeat: Repeat,
  scroll: ScrollText,
  calculator: Calculator,
};

const ROW = "flex items-center rounded-l-lg w-full transition-all duration-200";
const ACTIVE = "bg-white text-violet-950 rounded-r-none";
const IDLE =
  "text-white hover:text-violet-950 hover:bg-violet-200 hover:-translate-x-3 hover:rounded-lg rounded-r-none";

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

  const nav = useMemo(() => navFor(currentUser?.role), [currentUser?.role]);

  // One group open at a time: the one holding the current page, or the
  // one last clicked.
  const currentGroup = activeGroup(nav, pathname);
  const [openGroup, setOpenGroup] = useState<string | null>(currentGroup);
  useEffect(() => {
    if (currentGroup) setOpenGroup(currentGroup);
  }, [currentGroup]);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    await signOut();
  };

  const icon = (name: string, withLabel: boolean) => {
    const Icon = ICONS[name] ?? Sliders;
    return <Icon className={`w-4 h-4 shrink-0 ${withLabel ? "mr-3" : ""}`} />;
  };

  const renderLink = (item: NavLink, nested: boolean) => {
    const label = t(item.label);
    return (
      <li key={item.id}>
        <Link
          href={item.href}
          className={`${ROW} ${
            effectiveCollapsed ? "justify-center py-2" : nested ? "pl-9 pr-3 py-1.5" : "py-1.5 px-3"
          } ${isActive(item, pathname) ? ACTIVE : IDLE}`}
          title={effectiveCollapsed ? label : undefined}
        >
          {icon(item.icon, !effectiveCollapsed)}
          {!effectiveCollapsed && (
            <span suppressHydrationWarning className="flex-1 truncate">
              {label}
            </span>
          )}
          {!effectiveCollapsed && item.pro && <ProBadge />}
        </Link>
      </li>
    );
  };

  const renderGroup = (group: NavGroup) => {
    const label = t(group.label);
    const holdsCurrent = group.id === currentGroup;
    const open = !effectiveCollapsed && openGroup === group.id;
    return (
      <li key={group.id}>
        <button
          type="button"
          onClick={() => {
            if (effectiveCollapsed) {
              // Icons only: widen the menu and show this group.
              onToggle();
              setOpenGroup(group.id);
            } else {
              setOpenGroup(open ? null : group.id);
            }
          }}
          aria-expanded={open}
          className={`${ROW} ${effectiveCollapsed ? "justify-center py-2" : "py-1.5 px-3"} ${
            effectiveCollapsed && holdsCurrent ? ACTIVE : IDLE
          } ${holdsCurrent && !effectiveCollapsed ? "font-semibold" : ""}`}
          title={effectiveCollapsed ? label : undefined}
        >
          {icon(group.icon, !effectiveCollapsed)}
          {!effectiveCollapsed && (
            <>
              <span suppressHydrationWarning className="flex-1 text-left truncate">
                {label}
              </span>
              <ChevronDown
                className={`w-4 h-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
              />
            </>
          )}
        </button>
        {open && <ul className="mt-0.5 space-y-0.5">{group.items.map((item) => renderLink(item, true))}</ul>}
      </li>
    );
  };

  return (
    // As tall as the screen; only the menu scrolls, so the violet
    // background always reaches the bottom.
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
          <div className="flex items-center justify-between">
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
        ) : (
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-white">{t("nav.appName")}</h1>
            <button
              onClick={onToggle}
              className="p-1 text-white hover:bg-violet-800 rounded transition-colors"
              title={t("common.collapseSidebar")}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      <nav
        className={`flex-1 min-h-0 overflow-y-auto transition-all duration-300 ${
          effectiveCollapsed ? "p-1" : "p-2 pr-0"
        }`}
      >
        <ul className="space-y-0.5">
          {nav.map((entry) => (entry.kind === "link" ? renderLink(entry, false) : renderGroup(entry)))}
        </ul>
      </nav>

      <div
        className={`border-t border-violet-800 transition-all duration-300 ${
          effectiveCollapsed ? "p-1" : "p-2 pr-0"
        }`}
      >
        <button
          onClick={() => setShowBugReport(true)}
          className={`${ROW} ${effectiveCollapsed ? "justify-center py-2" : "py-1.5 px-3"} ${IDLE}`}
          title={effectiveCollapsed ? "Reportar un bug" : undefined}
        >
          <Bug className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
          {!effectiveCollapsed && <span suppressHydrationWarning>Reportar bug</span>}
        </button>
        <button
          onClick={handleLogout}
          disabled={isLoggingOut}
          className={`${ROW} mt-0.5 disabled:opacity-50 disabled:cursor-not-allowed ${
            effectiveCollapsed ? "justify-center py-2" : "py-1.5 px-3"
          } ${IDLE}`}
          title={effectiveCollapsed ? t("nav.logout") : undefined}
        >
          <LogOut className={`w-4 h-4 ${effectiveCollapsed ? "" : "mr-3"}`} />
          {!effectiveCollapsed && (
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
