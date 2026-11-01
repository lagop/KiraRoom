"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Info, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** The white card every chart and list of the page sits in. */
export function ChartCard({
  title,
  headingId,
  aside,
  subtitle,
  busy,
  busyLabel,
  children,
}: {
  title: ReactNode;
  headingId?: string;
  /** Right of the title: an icon, a badge or a control. */
  aside?: ReactNode;
  /** Under the title: the period, a legend. */
  subtitle?: ReactNode;
  /** A newer answer is loading; the old figures stay visible meanwhile. */
  busy?: boolean;
  busyLabel?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6"
      aria-labelledby={headingId}
      aria-busy={busy || undefined}
    >
      <div className="mb-4 sm:mb-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 id={headingId} className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            {title}
            {busy && <InlineSpinner label={busyLabel} />}
          </h2>
          {aside}
        </div>
        {subtitle}
      </div>
      {children}
    </section>
  );
}

/** A small spinner next to figures that are being refreshed. */
export function InlineSpinner({ label }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center">
      <Loader2 className="w-4 h-4 animate-spin text-indigo-500" aria-hidden />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}

/**
 * What a figure counts, behind a small info button. A title attribute only
 * shows to mouse users; this opens on tap, click and keyboard too.
 */
export function InfoHint({ label, text }: { label: string; text: string }) {
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label={label}
        className="inline-flex items-center justify-center rounded-full p-0.5 text-gray-400 hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        <Info className="w-3.5 h-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 max-w-[calc(100vw-2rem)] bg-white p-3 text-xs font-normal leading-relaxed text-gray-700"
      >
        {text}
      </PopoverContent>
    </Popover>
  );
}

/** A failed section: the reason and a retry, never empty charts that look like data. */
export function InlineError({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-yellow-200 bg-yellow-50 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-center">
        <AlertTriangle className="w-5 h-5 text-yellow-600 mr-3 flex-shrink-0" aria-hidden />
        <p className="text-sm text-yellow-800">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="self-start rounded-md border border-yellow-300 bg-white px-3 py-1.5 text-sm font-medium text-yellow-800 hover:bg-yellow-100 sm:self-auto"
      >
        {retryLabel}
      </button>
    </div>
  );
}

export function EmptyState({ text, className = "py-8" }: { text: string; className?: string }) {
  return <p className={`text-gray-500 text-center text-sm ${className}`}>{text}</p>;
}

/** A horizontal bar, decorative: the value is always printed next to it. */
export function Bar({
  width,
  color,
  size = "h-2",
  square = false,
}: {
  /** Percent of the track. */
  width: number;
  /** Defaults to indigo. */
  color?: string;
  size?: "h-2" | "h-6" | "h-8";
  square?: boolean;
}) {
  const radius = square ? "rounded-sm" : "rounded-full";
  return (
    <div className={`${size} ${radius} bg-gray-100 overflow-hidden`} aria-hidden>
      <div
        className={`h-full ${radius} transition-all duration-500 ${color ? "" : "bg-indigo-600"}`}
        style={{ width: `${width}%`, ...(color ? { backgroundColor: color } : {}) }}
      />
    </div>
  );
}

/** The first load of a section, before it has anything to show. */
export function LoadingBlock({ className = "h-48" }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <Loader2 className="w-6 h-6 animate-spin text-indigo-600" aria-hidden />
    </div>
  );
}
