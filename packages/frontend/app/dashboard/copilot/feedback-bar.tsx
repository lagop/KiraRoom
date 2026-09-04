"use client";

/**
 * P2A-staff-copilot-sprint16 — inline feedback widget.
 *
 * Thumbs up/down under each assistant reply, with an optional
 * comment box that appears when the user clicks 👎. Persists to the
 * `CopilotFeedback` table so the platform team can review quality
 * during the soft-launch without the user having to file a bug report.
 *
 * The widget is intentionally tiny — three icons, two clicks, and the
 * panel never blocks the user from continuing the conversation.
 */

import { useState } from "react";
import { ThumbsUp, ThumbsDown, Loader2, MessageSquare, X } from "lucide-react";
import apiClient from "@/lib/api";

export interface FeedbackBarProps {
  messageId: string;
}

export function FeedbackBar({ messageId }: FeedbackBarProps) {
  const [rating, setRating] = useState<0 | 1 | -1>(0);
  const [submitting, setSubmitting] = useState(false);
  const [comment, setComment] = useState("");
  const [showComment, setShowComment] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (next: 1 | -1, body?: { comment?: string }) => {
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.submitAssistantFeedback({
        messageId,
        rating: next,
        comment: body?.comment,
      });
      setRating(next);
      setSubmitted(true);
    } catch (err) {
      setError((err as Error)?.message ?? "Error");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-gray-400 mt-1">
        {rating === 1 ? (
          <>
            <ThumbsUp className="w-3 h-3 text-green-600 fill-green-600" /> Gracias por tu feedback.
          </>
        ) : (
          <>
            <ThumbsDown className="w-3 h-3 text-red-600 fill-red-600" /> Anotado, lo revisaremos.
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 text-[11px] text-gray-400 mt-1">
      <button
        disabled={submitting}
        onClick={() => submit(1)}
        title="Respuesta útil"
        className="p-1 hover:bg-green-50 rounded disabled:opacity-50"
      >
        {submitting && rating === 0 ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <ThumbsUp className="w-3 h-3" />
        )}
      </button>
      <button
        disabled={submitting}
        onClick={() => {
          setRating(-1);
          setShowComment(true);
        }}
        title="Respuesta no útil"
        className="p-1 hover:bg-red-50 rounded disabled:opacity-50"
      >
        <ThumbsDown className="w-3 h-3" />
      </button>
      {showComment && (
        <div className="ml-2 flex items-center gap-1.5 flex-1 max-w-md">
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="¿Qué esperaba? (opcional, max 500)"
            maxLength={500}
            className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-red-400"
          />
          <button
            onClick={() => submit(-1, { comment: comment || undefined })}
            disabled={submitting}
            className="text-[11px] font-medium text-white bg-red-600 hover:bg-red-700 rounded px-2 py-1 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Enviar'}
          </button>
          <button
            onClick={() => {
              setShowComment(false);
              setComment("");
            }}
            className="p-1 text-gray-400 hover:text-gray-700"
            title="Cancelar"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
      {error && (
        <span className="ml-2 text-[11px] text-red-600 inline-flex items-center gap-1">
          <MessageSquare className="w-3 h-3" /> {error}
        </span>
      )}
    </div>
  );
}
