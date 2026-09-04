"use client";

import { ReactNode, useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SaasSidebar } from "./components/sidebar";
import { SaasHeader } from "./components/header";
import { getToken } from "@/lib/api";

export default function SaasLayout({ children }: { children: ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Mobile-only drawer state. On viewports ≥md the sidebar is a
  // fixed-positioned column like before; on <md it slides over the
  // content with a backdrop.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const pathname = usePathname() || "";
  const router = useRouter();

  // Check auth on mount and when pathname changes
  useEffect(() => {
    // Skip check for login page
    if (pathname === "/saas/login") return;

    // Check if user is authenticated
    const token = getToken();
    const userJson = localStorage.getItem("user");
    const user = userJson ? JSON.parse(userJson) : null;

    if (!token || user?.role !== "saas_owner") {
      router.replace("/saas/login");
    }
  }, [pathname, router]);

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

  // Don't wrap login page with sidebar/header
  if (pathname === "/saas/login") {
    return <>{children}</>;
  }

  const toggleSidebar = () => {
    setSidebarCollapsed(!sidebarCollapsed);
  };
  const openMobileSidebar = () => setMobileSidebarOpen(true);
  const closeMobileSidebar = () => setMobileSidebarOpen(false);

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Sidebar — desktop (≥md) layout. On <md this slot is hidden
          entirely; the sidebar renders as an overlay instead. */}
      <div
        className={`hidden md:block sticky top-0 h-screen overflow-y-auto transition-all duration-300 ${
          sidebarCollapsed ? "w-16" : "w-64"
        }`}
      >
        <SaasSidebar
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
        className={`fixed inset-y-0 left-0 z-50 md:hidden transform transition-transform duration-300 ${
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <SaasSidebar
          collapsed={false}
          onToggle={closeMobileSidebar}
          showCloseButton
        />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col transition-all duration-300">
        {/* Header */}
        <SaasHeader
          onToggleSidebar={openMobileSidebar}
          // Desktop-mode collapse lives inside the sidebar itself; the
          // hamburger here only opens the mobile drawer.
          mobileOnly
        />

        {/* Page content */}
        <main className="flex-1 p-4 sm:p-6 bg-white shadow-sm">{children}</main>
      </div>
    </div>
  );
}