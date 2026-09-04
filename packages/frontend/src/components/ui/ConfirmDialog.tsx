"use client";

import * as React from "react"
import { cn } from "@/lib/utils"
import { Button } from "./Button"

export interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  loading?: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * P2A-receptionist-v2 M-2: drop-in replacement for `window.confirm()`.
 * Used by the billing page (and any future confirm flow) so we stop
 * blocking the main thread and match the rest of the design system.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  destructive = false,
  loading = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className={cn(
          "w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-xl",
          "animate-in fade-in zoom-in-95",
        )}
      >
        <h2
          id="confirm-dialog-title"
          className="mb-2 text-base font-semibold text-gray-900"
        >
          {title}
        </h2>
        {description && (
          <div className="mb-5 text-sm text-gray-600">{description}</div>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            size="sm"
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={loading}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
