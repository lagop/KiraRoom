"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  useOnboardingState,
  useDismissOnboardingChecklist,
  useRestoreOnboardingChecklist,
  useSkipOnboardingStep,
} from "./useOnboardingState";
import { Loader2, ChevronRight, X, RotateCcw } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import {
  checklistStartsOpen,
  pendingChecklistSteps,
  showChecklistRestore,
} from "@/lib/onboarding-wizard";

/** Remembered in this browser: the owner folded the checklist away. */
const FOLDED_KEY = "kira_onboarding_checklist_folded";

function readFolded(): boolean {
  try {
    return window.localStorage.getItem(FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeFolded(folded: boolean) {
  try {
    if (folded) window.localStorage.setItem(FOLDED_KEY, "1");
    else window.localStorage.removeItem(FOLDED_KEY);
  } catch {
    // Private mode or blocked storage: it just opens again next time.
  }
}

/**
 * Bottom-right, but above the copilot's button (bottom-6 right-6, 56 px),
 * which the panel and its pill used to cover.
 */
const CORNER = "fixed bottom-24 right-4 z-30";

/**
 * Persistent right-side drawer showing optional checklist items.
 *
 * Open on the dashboard home only. It used to open on every page, where
 * this 320 px panel covered buttons -- the import screen's "Siguiente",
 * the till's cart -- until it was closed. Elsewhere it starts as the small
 * pill and opens on demand. Once folded it stays folded, on the home too.
 */
export function OnboardingChecklist() {
  const t = useTranslations();
  const { data, isLoading } = useOnboardingState();
  const pathname = usePathname();
  const [open, setOpenState] = useState(() => checklistStartsOpen(pathname, readFolded()));
  const setOpen = (next: boolean) => {
    setOpenState(next);
    writeFolded(!next);
  };
  const dismiss = useDismissOnboardingChecklist();
  const skip = useSkipOnboardingStep();

  if (isLoading || !data) return null;
  if (data.checklistDismissed) return null;

  const items = data.defs.filter((d) => d.group === "checklist_optional");
  const pendingCount = pendingChecklistSteps(data);
  if (pendingCount === 0) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${CORNER} inline-flex items-center gap-2 rounded-full bg-violet-600 px-4 py-2 text-xs font-medium text-white shadow-lg hover:bg-violet-700`}
      >
        <ChevronRight className="h-3.5 w-3.5" />
        {t("onboarding.checklist.title")} ({pendingCount})
      </button>
    );
  }

  return (
    <div className={`${CORNER} w-80 max-w-[calc(100vw-2rem)] rounded-xl bg-white shadow-2xl ring-1 ring-gray-200`}>
      <div className="flex items-start justify-between border-b border-gray-100 p-4">
        <div>
          <div className="text-sm font-semibold text-gray-900">
            {t("onboarding.checklist.title")}
          </div>
          <div className="mt-0.5 text-xs text-gray-500">
            {t("onboarding.checklist.subtitle")}
          </div>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => dismiss.mutate()}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label={t("onboarding.checklist.dismiss")}
            title={t("onboarding.checklist.dismiss")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <ul className="max-h-72 overflow-y-auto p-2">
        {items.map((def) => {
          const s = data.steps[def.key];
          const status = s?.status ?? "pending";
          const done = status === "done";
          const skipped = status === "skipped";
          return (
            <li
              key={def.key}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-gray-50"
            >
              <div className="flex items-start gap-2">
                <span
                  className={
                    "mt-0.5 inline-block h-2.5 w-2.5 rounded-full " +
                    (done
                      ? "bg-green-500"
                      : skipped
                      ? "bg-gray-300"
                      : "bg-violet-400")
                  }
                />
                <div>
                  <div className={done ? "text-gray-400 line-through" : "text-gray-900"}>
                    {t(def.titleI18nKey)}
                  </div>
                  {def.href && (
                    <a
                      href={def.href}
                      className="text-[10px] text-violet-600 hover:underline"
                    >
                      {t("onboarding.checklist.pending")} →
                    </a>
                  )}
                </div>
              </div>
              {!done && !skipped && (
                <button
                  type="button"
                  onClick={() => skip.mutate(def.key)}
                  className="text-[10px] text-gray-400 hover:text-gray-600"
                >
                  {t("onboarding.checklist.skip")}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="border-t border-gray-100 p-2 text-right">
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t("onboarding.checklist.fold")}
          title={t("onboarding.checklist.fold")}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-50"
        >
          <ChevronRight className="h-3 w-3 rotate-180" />
        </button>
      </div>
    </div>
  );
}

export function OnboardingRestoreButton() {
  const t = useTranslations();
  const restore = useRestoreOnboardingChecklist();
  return (
    <button
      type="button"
      onClick={() => restore.mutate()}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100"
    >
      <RotateCcw className="h-3 w-3" />
      {t("onboarding.checklist.restore")}
    </button>
  );
}

export function OnboardingChecklistOrLoader() {
  const { data, isLoading } = useOnboardingState();
  if (isLoading) {
    return (
      <div className={`${CORNER} inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-xs text-gray-500 shadow-lg`}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </div>
    );
  }
  if (!data) return null;
  if (data.checklistDismissed) {
    // Nothing would come back: no button left in the corner for ever.
    if (!showChecklistRestore(data)) return null;
    return (
      <div className={CORNER}>
        <OnboardingRestoreButton />
      </div>
    );
  }
  return <OnboardingChecklist />;
}