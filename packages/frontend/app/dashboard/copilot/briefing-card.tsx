"use client";

/**
 * P2A-copilot-sprint13: the daily briefing card.
 *
 * Rendered at the top of the conversation the first time the user
 * opens the panel on a given day. The card is non-dismissible so the
 * copilot always surfaces "what's up" — a deliberate decision from
 * the discovery interviews: salon owners who skip briefings lose
 * 30-60% of the copilot's value (per the discovery doc).
 *
 * Sections are conditional on the caller's role:
 *   - lowStock: owner/manager/receptionist only
 *   - clientsAtRisk: shown to everyone (own-client subset for staff)
 *   - pendingConfirmations: only roles that book/manage
 */

import { useEffect, useState } from "react";
import apiClient, { DailyBriefing } from "@/lib/api";
import {
  Calendar,
  AlertTriangle,
  Package,
  UserX,
  Clock,
  Loader2,
  X,
} from "lucide-react";

export interface BriefingCardProps {
  /** Called when the user closes the card for the day. */
  onDismiss?: () => void;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BriefingCard({ onDismiss }: BriefingCardProps) {
  const [briefing, setBriefing] = useState<DailyBriefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem("copilot.briefing.dismissed") : null;
    if (stored === todayKey()) setDismissed(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiClient.getAssistantDailyBriefing();
        if (!cancelled) setBriefing(data);
      } catch (err) {
        if (!cancelled) setError((err as Error)?.message ?? "Error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    setDismissed(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("copilot.briefing.dismissed", todayKey());
    }
    onDismiss?.();
  };

  if (dismissed) return null;
  if (loading) {
    return (
      <div className="bg-white border border-purple-200 rounded-xl p-4 flex items-center gap-3 text-sm text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span>Preparando tu briefing…</span>
      </div>
    );
  }
  if (error || !briefing) return null;

  const isEmpty =
    briefing.appointments.total === 0 &&
    briefing.pendingConfirmations.total === 0 &&
    briefing.gaps.total === 0 &&
    briefing.lowStock.total === 0 &&
    briefing.clientsAtRisk.total === 0;

  return (
    <div className="bg-gradient-to-br from-purple-50 to-white border border-purple-200 rounded-xl p-4 shadow-sm relative">
      <button
        onClick={dismiss}
        title="Cerrar briefing"
        className="absolute top-2 right-2 p-1 text-gray-400 hover:text-gray-700 rounded"
      >
        <X className="w-3.5 h-3.5" />
      </button>

      <div className="flex items-center gap-2 mb-2">
        <Calendar className="w-4 h-4 text-purple-600" />
        <h3 className="text-sm font-semibold text-gray-900">
          Briefing — {formatDate(briefing.date)}
        </h3>
      </div>

      {isEmpty ? (
        <p className="text-sm text-gray-600 leading-relaxed">
          No hay citas hoy. Buen momento para ponerse al día con el inventario
          o llamar a las clientas en riesgo.
        </p>
      ) : (
        <div className="space-y-2.5 text-sm">
          <SummaryLine
            icon={<Calendar className="w-3.5 h-3.5 text-purple-600" />}
            label="Agenda"
            value={`${briefing.appointments.confirmed} confirmadas, ${briefing.appointments.pending} pendientes`}
          />
          {briefing.pendingConfirmations.total > 0 && (
            <SummaryLine
              icon={<AlertTriangle className="w-3.5 h-3.5 text-amber-600" />}
              label="Por confirmar"
              value={briefing.pendingConfirmations.items
                .slice(0, 3)
                .map(
                  (i) =>
                    `${i.time} · ${i.clientFirstName ?? "?"}`,
                )
                .join(" · ")}
              trailing={
                briefing.pendingConfirmations.total > 3
                  ? `+${briefing.pendingConfirmations.total - 3}`
                  : undefined
              }
            />
          )}
          {briefing.gaps.total > 0 && (
            <SummaryLine
              icon={<Clock className="w-3.5 h-3.5 text-blue-600" />}
              label="Huecos"
              value={`${briefing.gaps.total} hueco(s) — el mayor de ${Math.max(
                ...briefing.gaps.items.map((g) => g.minutes),
              )} min`}
            />
          )}
          {briefing.lowStock.total > 0 && (
            <SummaryLine
              icon={<Package className="w-3.5 h-3.5 text-red-600" />}
              label="Stock bajo"
              value={briefing.lowStock.items.map((i) => i.name).join(", ")}
              trailing={
                briefing.lowStock.total > briefing.lowStock.items.length
                  ? `+${briefing.lowStock.total - briefing.lowStock.items.length}`
                  : undefined
              }
            />
          )}
          {briefing.clientsAtRisk.total > 0 && (
            <SummaryLine
              icon={<UserX className="w-3.5 h-3.5 text-orange-600" />}
              label="En riesgo"
              value={briefing.clientsAtRisk.items
                .map((c) => `${c.firstName}${c.daysSinceLastVisit != null ? ` (${c.daysSinceLastVisit}d)` : ""}`)
                .join(", ")}
              trailing={
                briefing.clientsAtRisk.total >
                briefing.clientsAtRisk.items.length
                  ? `+${briefing.clientsAtRisk.total - briefing.clientsAtRisk.items.length}`
                  : undefined
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function SummaryLine({
  icon,
  label,
  value,
  trailing,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  trailing?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <span className="font-medium text-gray-900">{label}: </span>
        <span className="text-gray-700">{value}</span>
        {trailing && (
          <span className="ml-1 text-xs text-gray-500">{trailing}</span>
        )}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(`${iso}T00:00:00`);
    return d.toLocaleDateString("es-ES", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  } catch {
    return iso;
  }
}
