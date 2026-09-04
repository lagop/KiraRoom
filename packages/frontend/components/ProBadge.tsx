"use client";

import { useTranslations } from "@/lib/use-translation";

export function ProBadge() {
  const t = useTranslations();
  return (
    <span
      className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-700/60 text-violet-100"
      title={t("common.proBadgeTooltip")}
    >
      {t("common.proBadge")}
    </span>
  );
}
