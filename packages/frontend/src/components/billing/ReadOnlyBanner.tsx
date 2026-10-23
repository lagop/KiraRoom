"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { useTenantContext } from "../../hooks/useFeatureAccess";
import { readOnlyNotice } from "../../../lib/read-only-notice";

/**
 * Across the dashboard while the salon is read-only: its trial ended without
 * a plan, or its subscription was cancelled or suspended. The server refuses
 * every change then (ReadOnlyTenantGuard) and the salon's page takes no
 * bookings; without this, the owner only found out from errors on each save.
 */
export function ReadOnlyBanner() {
  const notice = readOnlyNotice(useTenantContext());
  if (!notice) return null;

  return (
    <div
      role="status"
      className="flex flex-col gap-2 border-b border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900 sm:flex-row sm:items-center sm:justify-between sm:px-6"
    >
      <div className="flex items-start gap-3">
        <Lock className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-700" aria-hidden="true" />
        <p>
          <strong className="font-semibold">{notice.title}</strong> {notice.body}
        </p>
      </div>
      <Link
        href="/dashboard/billing"
        className="self-start whitespace-nowrap rounded-md bg-red-700 px-3 py-1.5 font-medium text-white hover:bg-red-800 sm:self-auto"
      >
        {notice.cta}
      </Link>
    </div>
  );
}
