"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { useTenantContext } from "../../hooks/useFeatureAccess";
import { canManageBilling, readOnlyNotice } from "../../../lib/read-only-notice";
import { getCurrentUser } from "../../../lib/utils";

/**
 * Across the dashboard while the salon is read-only: its trial ended without
 * a plan, or its subscription was cancelled or suspended. The server refuses
 * every change then (ReadOnlyTenantGuard) and the salon's page takes no
 * bookings; without this, the owner only found out from errors on each save.
 */
export function ReadOnlyBanner() {
  const ctx = useTenantContext();
  // Read after mount (localStorage). Facturación is the owner's only: an
  // admin or a professional is asked to tell her instead of a link they
  // cannot use.
  const [role, setRole] = useState<string | null | undefined>(undefined);
  useEffect(() => setRole(getCurrentUser()?.role ?? null), []);
  const notice = readOnlyNotice({ ...ctx, canManageBilling: canManageBilling(role) });
  if (role === undefined || !notice) return null;

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
      {notice.cta && (
        <Link
          href="/dashboard/billing"
          className="self-start whitespace-nowrap rounded-md bg-red-700 px-3 py-1.5 font-medium text-white hover:bg-red-800 sm:self-auto"
        >
          {notice.cta}
        </Link>
      )}
    </div>
  );
}
