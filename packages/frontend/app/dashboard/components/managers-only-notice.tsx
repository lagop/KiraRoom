"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";

/**
 * Shown by the dashboard layout instead of a page that is for the owner and
 * managers only (managersOnlyPage), when a professional opens it by its
 * address: the page and its requests are not rendered at all.
 */
export function ManagersOnlyNotice() {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-4">
      <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mb-4">
        <Lock className="w-6 h-6 text-gray-500" aria-hidden="true" />
      </div>
      <h1 className="text-lg font-semibold text-gray-900">{t("managersOnly.title")}</h1>
      <p className="mt-2 text-sm text-gray-600 max-w-md">{t("managersOnly.body")}</p>
      <Link
        href="/dashboard"
        className="mt-6 inline-flex items-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
      >
        {t("managersOnly.home")}
      </Link>
    </div>
  );
}
