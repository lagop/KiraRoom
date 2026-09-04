"use client";

/**
 * P2A-staff-copilot: floating action button that opens the slide-over
 * panel. Mounted in the dashboard layout so it's always available.
 */

import { useState } from "react";
import { Sparkles, X } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import { CopilotPanel } from "./copilot-panel";

export function CopilotFab() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        title={t("copilot.fab_label")}
        className="fixed bottom-6 right-6 z-30 w-14 h-14 rounded-full bg-purple-600 hover:bg-purple-700 text-white shadow-lg flex items-center justify-center transition-transform hover:scale-105"
        aria-label={t("copilot.fab_label")}
      >
        {open ? <X className="w-6 h-6" /> : <Sparkles className="w-6 h-6" />}
      </button>
      {open && (
        <CopilotPanel onClose={() => setOpen(false)} />
      )}
    </>
  );
}
