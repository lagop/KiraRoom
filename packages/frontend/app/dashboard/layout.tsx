"use client";

import { ReactNode, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { DashboardSidebar } from "./components/sidebar";
import { DashboardHeader } from "./components/header";
import apiClient, { decodeJwtToken, getToken, removeToken, removeRefreshToken } from "@/lib/api";
import { ShieldAlert } from "lucide-react";
import { OnboardingHost } from "./_components/onboarding/OnboardingHost";
import CookieBanner from "../components/cookie-banner";
import { ReadOnlyBanner } from "@/components/billing/ReadOnlyBanner";
import { TrialEndingBanner } from "@/components/billing/TrialEndingBanner";
import { EmailVerificationBanner } from "@/components/auth/email-verification-banner";
import { TermsAcceptanceModal } from "@/components/auth/terms-acceptance-modal";
import { managersOnlyPage } from "@/lib/dashboard-nav";
import { getCurrentUser } from "@/lib/utils";
import { ManagersOnlyNotice } from "./components/managers-only-notice";

/**
 * Decode the current access token's impersonation claims and update
 * local state. Sourced from the JWT (not the URL) so the banner
 * survives hard reloads and in-app navigations.
 *
 * Re-runs on every route change (Next.js App Router preserves the
 * dashboard layout across siblings, so a useEffect with the right
 * dependency list is the only place that picks up fresh token claims
 * after a refreshAccessToken). Also subscribes to the `storage`
 * event so a logout on another tab clears the banner here too.
 */
function readImpersonationFromStorage(): {
  by?: string;
  id?: string;
  tenantId?: string;
} | null {
  if (typeof window === "undefined") return null;
  try {
    const token = getToken();
    if (!token) return null;
    const claims = decodeJwtToken(token) as
      | null
      | { impersonatedBy?: string; impersonationId?: string; impersonatedTenantId?: string };
    if (claims && claims.impersonatedBy) {
      return {
        by: claims.impersonatedBy,
        id: claims.impersonationId,
        tenantId: claims.impersonatedTenantId,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Mobile-only drawer state. On viewports ≥md the sidebar is a
  // fixed-positioned column like before; on <md it slides over the
  // content with a backdrop.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [impersonation, setImpersonation] = useState<{
    by?: string;
    id?: string;
    tenantId?: string;
  } | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  // Close the mobile drawer on every navigation so it doesn't stay
  // pinned open after the user picks a link.
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [pathname]);

  // Lock body scroll while the mobile drawer is open so the page
  // underneath doesn't scroll when the user taps the backdrop.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (mobileSidebarOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
    return undefined;
  }, [mobileSidebarOpen]);

  // Effect 1: re-decode on every route change. Critical because
  // Next.js App Router keeps the layout mounted across sibling
  // navigations, so without `pathname` in the dependency list the
  // effect would never fire after the first mount and a fresh
  // impersonated access token from a silent refresh would not update
  // the banner.
  useEffect(() => {
    setImpersonation(readImpersonationFromStorage());
  }, [pathname]);

  // The signed-in role, read after mount (the server has no user) and again
  // on each page, as the sidebar does. Undefined until read: the page is not
  // mounted before, so a management page opened by a professional never
  // sends its requests; on later pages the role is already known.
  const [role, setRole] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, [pathname]);
  // A management page a professional opened by its address: the notice, not
  // the page (whose buttons the API would refuse).
  const blocked = managersOnlyPage(role, pathname ?? "");

  // Effect 2: cross-tab sync. If the user logs out in another tab, the
  // `storage` event fires here so this tab's banner disappears too.
  // The impersonated session is single-tab anyway (JWT in localStorage
  // only), but the cleanup is cheap and prevents ghost banners.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === "kira_auth_token" || e.key === "user") {
        setImpersonation(readImpersonationFromStorage());
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed);
  };
  const openMobileSidebar = () => setMobileSidebarOpen(true);
  const closeMobileSidebar = () => setMobileSidebarOpen(false);

  const exitImpersonation = async () => {
    // Server first, while the access token still exists: it ends the
    // impersonated session and clears its cookie. apiClient.logout empties
    // the local tokens either way.
    try {
      await apiClient.logout();
    } catch {
      removeToken();
      removeRefreshToken();
    }
    if (typeof window !== "undefined") {
      localStorage.removeItem("user");
    }
    router.replace("/saas/login");
  };

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar — a column from md up. Below md it is not rendered as
          a column (it pushed the page right and looked open on load):
          the header's menu button opens the drawer below, which starts
          closed. Pure CSS, so server and client render the same. */}
      <div
        className={`hidden md:block shrink-0 sticky top-0 self-start h-screen overflow-y-auto transition-all duration-300 z-20 ${
          sidebarCollapsed ? "w-16" : "w-64"
        }`}
      >
        <DashboardSidebar
          collapsed={sidebarCollapsed}
          onToggle={toggleSidebar}
        />
      </div>

      {/* Sidebar — mobile drawer (<md). */}
      {mobileSidebarOpen && (
        <div
          aria-hidden="true"
          onClick={closeMobileSidebar}
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
        />
      )}
      <div
        // Closed: off screen and invisible, so its links are not tabbable
        // or read out while it is shut.
        aria-hidden={!mobileSidebarOpen}
        className={`fixed inset-y-0 left-0 z-50 md:hidden transform transition-[transform,visibility] duration-300 ${
          mobileSidebarOpen ? "visible translate-x-0" : "invisible -translate-x-full"
        }`}
      >
        <DashboardSidebar
          collapsed={false}
          onToggle={closeMobileSidebar}
          showCloseButton
        />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col transition-all duration-300">
        {impersonation && (
          <div
            role="alert"
            className="bg-red-600 text-white px-4 sm:px-6 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
          >
            <div className="flex items-start sm:items-center space-x-3">
              <ShieldAlert className="w-5 h-5 flex-shrink-0 mt-0.5 sm:mt-0" />
              <div className="text-sm">
                <strong className="font-semibold">
                  You are impersonating this tenant.
                </strong>{" "}
                Every action you take is attributed to your account in the
                <code className="mx-1 bg-red-700 px-1 rounded">audit_logs</code>
                table (impersonation id{" "}
                <code className="bg-red-700 px-1 rounded break-all">
                  {impersonation.id}
                </code>
                ). End the session when you are done.
              </div>
            </div>
            <button
              onClick={exitImpersonation}
              className="bg-white text-red-700 px-3 py-1 rounded font-medium text-sm hover:bg-red-50 self-start sm:self-auto flex-shrink-0"
            >
              Exit impersonation
            </button>
          </div>
        )}
        {/* Header */}
        <DashboardHeader
          onToggleSidebar={openMobileSidebar}
          // Desktop-mode collapse lives inside the sidebar itself; the
          // hamburger here only opens the mobile drawer.
          mobileOnly
        />
        {/* Trial ended without a plan, or the subscription was cancelled or suspended. */}
        <ReadOnlyBanner />
        {/* Last 7 days of the trial, owner only (D25). */}
        <TrialEndingBanner />
        {/* Owner whose email is not confirmed: a new link (audit 7A, S1). */}
        <EmailVerificationBanner />

        {/* Page content */}
        <main className="flex-1 p-6 bg-white shadow-sm min-w-0 overflow-x-hidden">
          {role === undefined ? null : blocked ? <ManagersOnlyNotice /> : children}
        </main>
      </div>
      {/* P1 — Onboarding wizard surfaces */}
      <OnboardingHost />
      {/* Owner of a salon without an acceptance of the current terms (D3). */}
      <TermsAcceptanceModal />
      {/* GDPR — Cookie consent banner */}
      <CookieBanner />
    </div>
  );
}
