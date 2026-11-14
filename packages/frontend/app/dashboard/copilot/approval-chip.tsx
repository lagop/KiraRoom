"use client";

/**
 * P2A-staff-copilot-sprint14: inline approval chip for pending
 * `ActionApproval` rows. Renders next to the LLM's reply and offers
 * Approve / Reject buttons.
 *
 * Approve always requires a confirmation click (per the RFC: every
 * write tool needs an explicit human signal).
 *
 * Copilot audit M9: the card shows the action's real state, from the
 * server (`approval` on the message), also after a reload; the result is
 * said in words (the coupon code, the tool's message), not only as JSON.
 */

import { useState } from "react";
import apiClient, { ApiError } from "@/lib/api";
import { Check, X, Loader2, AlertTriangle, ChevronDown, ChevronUp, Ban, Clock } from "lucide-react";
import {
  type ApprovalCardState,
  type ApprovalInfo,
  approvalCardState,
  approvalResultLines,
  stateFromResolveError,
} from "@/lib/copilot-approval";

export interface ApprovalChipProps {
  approvalId: string;
  toolName: string;
  preview: string;
  /** The action's state as the server has it. */
  approval: ApprovalInfo;
  /** Called after a successful resolve so the parent can refetch messages. */
  onResolved?: () => void;
}

export function ApprovalChip({ approvalId, toolName, preview, approval, onResolved }: ApprovalChipProps) {
  const [busy, setBusy] = useState(false);
  // What this click produced, until the parent's refetch brings it.
  const [local, setLocal] = useState<{ state: ApprovalCardState; result?: unknown } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const state = local?.state ?? approvalCardState(approval);
  const result = local ? local.result : approval.result;

  const decide = async (action: "approve" | "reject") => {
    setBusy(true);
    setErrorText(null);
    try {
      const res = await apiClient.resolveAssistantApproval(approvalId, { action });
      setLocal({
        state: approvalCardState({ status: res.status as ApprovalInfo["status"], expiresAt: approval.expiresAt, result: res.resultSnapshot }),
        result: res.resultSnapshot,
      });
      onResolved?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      const known = stateFromResolveError(message, err instanceof ApiError ? err.status : undefined);
      if (known) {
        setLocal({ state: known });
        onResolved?.();
      } else {
        setErrorText("No se pudo completar la acción. Inténtalo de nuevo.");
      }
    } finally {
      setBusy(false);
    }
  };

  if (state === "pending") {
    return (
      <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm">
        <div className="flex items-start gap-2 mb-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-700 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-medium text-amber-900">{actionLabel(toolName, "pending")}</div>
            <div className="text-amber-800 whitespace-pre-line">{preview}</div>
          </div>
        </div>
        {errorText && (
          <div className="mb-2 text-xs text-red-700" role="alert">
            {errorText}
          </div>
        )}
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={() => decide("reject")}
            className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => decide("approve")}
            className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Check className="w-3 h-3" aria-hidden="true" />}
            Aprobar
          </button>
        </div>
      </div>
    );
  }

  const look = LOOK[state];
  const Icon = look.icon;
  const lines = state === "done" || state === "failed" ? approvalResultLines(result) : [];
  const title = state === "done" ? actionLabel(toolName, "done") : look.title;

  return (
    <div className={`rounded-lg p-3 text-sm border flex items-start gap-2 ${look.className}`}>
      <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${state === "running" ? "animate-spin" : ""}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-xs opacity-80 whitespace-pre-line">{preview}</div>
        {lines.map((line) => (
          <p key={line} className="mt-1 whitespace-pre-line text-xs font-medium">
            {line}
          </p>
        ))}
        {result != null && (state === "done" || state === "failed") && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="text-xs mt-1 underline flex items-center gap-1"
          >
            {expanded ? "Ocultar detalle técnico" : "Ver detalle técnico"}
            {expanded ? <ChevronUp className="w-3 h-3" aria-hidden="true" /> : <ChevronDown className="w-3 h-3" aria-hidden="true" />}
          </button>
        )}
        {expanded && (
          <pre className="mt-2 p-2 bg-white/50 rounded text-[11px] overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

const LOOK: Record<Exclude<ApprovalCardState, "pending">, { title: string; className: string; icon: typeof Check }> = {
  running: { title: "Haciéndolo…", className: "bg-amber-50 border-amber-200 text-amber-900", icon: Loader2 },
  done: { title: "Hecho", className: "bg-green-50 border-green-200 text-green-900", icon: Check },
  failed: { title: "No se pudo hacer la acción.", className: "bg-red-50 border-red-200 text-red-900", icon: AlertTriangle },
  forbidden: {
    title: "No se hizo: no tienes permiso para esta acción.",
    className: "bg-red-50 border-red-200 text-red-900",
    icon: Ban,
  },
  cancelled: { title: "Cancelada. No se ha hecho nada.", className: "bg-gray-50 border-gray-200 text-gray-700", icon: X },
  expired: {
    title: "Caducada: no se aprobó a tiempo y no se ha hecho nada.",
    className: "bg-gray-50 border-gray-200 text-gray-600",
    icon: Clock,
  },
};

function actionLabel(toolName: string, state: "pending" | "done"): string {
  switch (toolName) {
    case "send_message":
      return state === "pending" ? "Pendiente: enviar WhatsApp" : "WhatsApp enviado";
    case "reschedule_appointment":
      return state === "pending" ? "Pendiente: mover cita" : "Cita movida";
    case "close_waitlist_slot":
      return state === "pending" ? "Pendiente: avisar a la lista de espera" : "Aviso a la lista de espera enviado";
    case "mark_no_show":
      return state === "pending" ? "Pendiente: marcar que no vino" : "Marcada como no presentada";
    case "create_coupon":
      return state === "pending" ? "Pendiente: crear cupón" : "Cupón creado";
    default:
      return state === "pending" ? "Acción pendiente" : "Hecho";
  }
}
