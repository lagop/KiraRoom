"use client";

import React from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { countKey } from "@/lib/home-dashboard";
import { useTranslations } from "@/lib/use-translation";

interface UnreadNotificationsBadgeProps {
  count: number;
  className?: string;
}

/**
 * Compact, dashboard-sized badge linking to the notifications page.
 * Renders nothing when count is 0 so the dashboard stays uncluttered
 * for tenants with no pending alerts.
 */
export const UnreadNotificationsBadge: React.FC<
  UnreadNotificationsBadgeProps
> = ({ count, className = "" }) => {
  const t = useTranslations();
  if (count <= 0) return null;

  return (
    <Link
      href="/dashboard/notifications"
      className={`inline-flex items-center gap-2 px-3 py-1.5 bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded-full transition-colors ${className}`}
    >
      <Bell className="w-4 h-4 text-violet-600" aria-hidden />
      <span className="text-xs font-semibold text-violet-700">
        {t(countKey("dashboard.unread_notifications", count), { count })}
      </span>
    </Link>
  );
};
