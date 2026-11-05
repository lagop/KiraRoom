"use client";

import { useRef, type KeyboardEvent } from "react";
import { Lock, Star, Users } from "lucide-react";
import type { Tab, Translate } from "../analytics-types";

const TABS: Tab[] = ["overview", "professionals", "clients"];

export const tabId = (tab: Tab) => `analytics-tab-${tab}`;
export const panelId = (tab: Tab) => `analytics-panel-${tab}`;

/**
 * Resumen / Profesionales / Clientas. Pro and Empresa open them; Esencial
 * sees the last two locked. Arrow keys move between tabs (WAI-ARIA tabs).
 */
export function AnalyticsTabs({
  t,
  active,
  locked,
  onChange,
}: {
  t: Translate;
  active: Tab;
  /** Esencial: the advanced tabs show a lock. */
  locked: boolean;
  onChange: (tab: Tab) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const labels: Record<Tab, string> = {
    overview: t("analytics.overview"),
    professionals: t("analytics.professionals"),
    clients: t("analytics.clients"),
  };
  const icons = { overview: null, professionals: Star, clients: Users };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.indexOf(active);
    const next =
      e.key === "ArrowRight"
        ? TABS[(i + 1) % TABS.length]
        : e.key === "ArrowLeft"
          ? TABS[(i - 1 + TABS.length) % TABS.length]
          : e.key === "Home"
            ? TABS[0]
            : e.key === "End"
              ? TABS[TABS.length - 1]
              : null;
    if (!next) return;
    e.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="border-b border-gray-200">
      <div
        className="flex gap-4 sm:gap-8 overflow-x-auto"
        role="tablist"
        aria-label={t("analytics.sections_label")}
        onKeyDown={onKeyDown}
      >
        {TABS.map((tab) => {
          const Icon = icons[tab];
          const selected = active === tab;
          return (
            <button
              key={tab}
              ref={(el) => {
                refs.current[tab] = el;
              }}
              type="button"
              role="tab"
              id={tabId(tab)}
              aria-selected={selected}
              aria-controls={panelId(tab)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab)}
              className={`py-4 px-1 border-b-2 font-medium text-sm flex flex-shrink-0 items-center transition-colors ${
                selected
                  ? "border-indigo-500 text-indigo-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {Icon && <Icon className="w-4 h-4 mr-1" aria-hidden />}
              {labels[tab]}
              {tab !== "overview" && locked && (
                <>
                  <Lock className="w-3.5 h-3.5 ml-1 text-gray-400" aria-hidden />
                  <span className="sr-only"> ({t("analytics.locked_short")})</span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
