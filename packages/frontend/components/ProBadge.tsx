"use client";

import { useTranslations } from "@/lib/use-translation";

/** The plan a menu entry needs: Pro (and up) or Empresa. */
export function ProBadge({ plan = "pro" }: { plan?: "pro" | "empresa" }) {
  const t = useTranslations();
  const empresa = plan === "empresa";
  return (
    <span
      className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-700/60 text-violet-100"
      title={t(empresa ? "common.empresaBadgeTooltip" : "common.proBadgeTooltip")}
    >
      {t(empresa ? "common.empresaBadge" : "common.proBadge")}
    </span>
  );
}
