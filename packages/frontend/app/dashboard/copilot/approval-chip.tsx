"use client";

/**
 * P2A-staff-copilot-sprint14: inline approval chip for pending
 * `ActionApproval` rows. Renders next to the LLM's reply and offers
 * Approve / Reject buttons. On approve, the chip shows a brief
 * "ejecutando…" spinner, then collapses with the result snapshot.
 *
 * Approve always requires a confirmation click (per the RFC: every
 * write tool needs an explicit human signal).
 */

import { useState } from "react";
import apiClient from "@/lib/api";
import { Check, X, Loader2, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";

export interface ApprovalChipProps {
  approvalId: string;
  toolName: string;
  preview: string;
  expiresAt: string;
  conversationId: string;
  /** Called after a successful resolve so the parent can refetch messages. */
  onResolved?: () => void;
}

interface ResolvedState {
  status: 'approved' | 'rejected' | 'executed' | 'expired';
  result?: unknown;
}

export function ApprovalChip({
  approvalId,
  toolName,
  preview,
  expiresAt,
  conversationId,
  onResolved,
}: ApprovalChipProps) {
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState<ResolvedState | null>(null);
  const [expanded, setExpanded] = useState(false);

  const isExpired = new Date(expiresAt).getTime() < Date.now();
  if (isExpired && !resolved) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm text-gray-500 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <div>
          <div className="font-medium text-gray-700">Acción caducada</div>
          <div className="text-xs">{preview}</div>
        </div>
      </div>
    );
  }

  const decide = async (action: 'approve' | 'reject') => {
    setBusy(true);
    try {
      const res: any = await (apiClient as any).resolveAssistantApproval?.(
        approvalId,
        { action },
      ) ?? await fetch(`/api/v1/assistant/approvals/${approvalId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      }).then((r) => r.json());
      setResolved({ status: res?.status ?? (action === 'approve' ? 'executed' : 'rejected'), result: res?.resultSnapshot });
      onResolved?.();
    } catch (err) {
      setResolved({ status: 'expired' });
    } finally {
      setBusy(false);
    }
  };

  if (resolved) {
    const success = resolved.status === 'approved' || resolved.status === 'executed';
    const failure =
      resolved.result &&
      typeof resolved.result === 'object' &&
      (resolved.result as any).error &&
      (resolved.result as any).error !== 'forbidden';
    return (
      <div
        className={`rounded-lg p-3 text-sm border flex items-start gap-2 ${
          success && !failure
            ? 'bg-green-50 border-green-200 text-green-900'
            : 'bg-red-50 border-red-200 text-red-900'
        }`}
      >
        <Check className="w-4 h-4 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {success && !failure
              ? actionLabel(toolName, 'done')
              : failure
              ? 'No se pudo ejecutar la acción.'
              : 'Acción cancelada.'}
          </div>
          {resolved.result != null && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-xs mt-1 underline flex items-center gap-1"
            >
              {expanded ? 'Ocultar detalle' : 'Ver detalle'}
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
          {expanded && (
            <pre className="mt-2 p-2 bg-white/50 rounded text-[11px] overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(resolved.result, null, 2)}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-amber-50 border border-amber-300 rounded-lg p-3 text-sm">
      <div className="flex items-start gap-2 mb-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-700 shrink-0" />
        <div className="min-w-0">
          <div className="font-medium text-amber-900">{actionLabel(toolName, 'pending')}</div>
          <div className="text-amber-800">{preview}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 justify-end">
        <button
          disabled={busy}
          onClick={() => decide('reject')}
          className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
        >
          Cancelar
        </button>
        <button
          disabled={busy}
          onClick={() => decide('approve')}
          className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Aprobar
        </button>
      </div>
    </div>
  );
}

function actionLabel(toolName: string, state: 'pending' | 'done'): string {
  switch (toolName) {
    case 'draft_follow_up_message':
      return state === 'pending' ? 'Borrador listo para revisar' : 'Borrador guardado';
    case 'send_message':
      return state === 'pending' ? 'Pendiente: enviar WhatsApp' : 'WhatsApp enviado';
    case 'reschedule_appointment':
      return state === 'pending' ? 'Pendiente: mover cita' : 'Cita movida';
    default:
      return state === 'pending' ? 'Acción pendiente' : 'Acción completada';
  }
}
