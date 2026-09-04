"use client";

/**
 * P2A-staff-copilot: slide-over chat panel for the in-app assistant.
 * Used both as a docked panel from the main dashboard (via the FAB) and
 * as a focused page on /dashboard/copilot.
 */

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "@/lib/use-translation";
import { X, Send, Loader2, Sparkles, AlertCircle, Trash2, Lock } from "lucide-react";
import { useCopilotConversation } from "./use-copilot-conversation";
import { BriefingCard } from "./briefing-card";
import { ApprovalChip } from "./approval-chip";
import { UpgradePrompt } from "./upgrade-prompt";
import { FeedbackBar } from "./feedback-bar";
import { getCurrentUser } from "@/lib/utils";

export interface CopilotPanelProps {
  /** When true the panel takes the full width (used on the focused /copilot page). */
  fullPage?: boolean;
  /** Optional close handler — if omitted, the panel renders without an X button (full-page mode). */
  onClose?: () => void;
}

export function CopilotPanel({ fullPage = false, onClose }: CopilotPanelProps) {
  const t = useTranslations();
  const { state, send, clear, tier, costCapReached } = useCopilotConversation();
  const user = getCurrentUser();
  const firstName = user?.id ? " " : "";
  const role = user?.role ?? "staff";
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the latest message whenever the list changes.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [state.messages.length]);

  const assistantName = "Kira";
  const intro = t("copilot.intro").replace(
    "{name}",
    user?.id ? "" : assistantName,
  );

  // P2A-staff-copilot-sprint15: free-tier tenants can't reach this
  // component (FeatureGuard returns 403). But if the user just
  // downgraded mid-session we still want to show a clean message.
  if (tier === "free") {
    return (
      <div className={fullPage ? "flex flex-col h-full bg-white" : "fixed inset-y-0 right-0 w-full sm:w-[480px] bg-white shadow-2xl flex flex-col z-40 border-l border-gray-200"}>
        <header className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gradient-to-r from-purple-50 to-white">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-full bg-purple-600 flex items-center justify-center text-white shrink-0">
              <Lock className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-gray-900 truncate">
                Copiloto · Plan {tier}
              </h2>
              <p className="text-xs text-gray-500">No incluido en tu plan actual</p>
            </div>
          </div>
          {onClose && (
            <button onClick={onClose} className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg">
              <X className="w-5 h-5" />
            </button>
          )}
        </header>
        <div className="flex-1 overflow-y-auto p-5 bg-gray-50">
          <UpgradePrompt />
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        fullPage
          ? "flex flex-col h-full bg-white"
          : "fixed inset-y-0 right-0 w-full sm:w-[480px] bg-white shadow-2xl flex flex-col z-40 border-l border-gray-200"
      }
    >
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-4 border-b border-gray-200 bg-gradient-to-r from-purple-50 to-white">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-purple-600 flex items-center justify-center text-white shrink-0">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900 truncate">
              {t("copilot.title")}
            </h2>
            <p className="text-xs text-gray-500">
              {assistantName} · {role}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={clear}
            title={t("copilot.clear")}
            className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </header>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 py-4 space-y-4 bg-gray-50"
      >
        {costCapReached && (
          <div className="bg-amber-50 border border-amber-300 text-amber-900 text-sm rounded-lg p-3">
            Has alcanzado el límite de uso mensual del copiloto. Se reactiva el día 1 del próximo mes.
          </div>
        )}
        {state.loading && state.messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        )}

        {state.messages.length === 0 && !state.loading && (
          <>
            <BriefingCard />
            <div className="bg-white border border-gray-200 rounded-xl p-5 text-sm text-gray-700 leading-relaxed">
              {intro}
            </div>
          </>
        )}

        {state.messages.map((m) => {
          if (m.role === "user") {
            return <UserBubble key={m.id} content={m.content} />;
          }
          if (m.role === "approval" && m.pendingActionId && m.toolName) {
            return (
              <ApprovalChip
                key={m.id}
                approvalId={m.pendingActionId}
                toolName={m.toolName}
                preview={m.content}
                // expiresAt isn't on AssistantMessage in the public
                // shape — the panel polls /approvals separately for
                // the canonical expiry. Default to 5 minutes from
                // message creation so the chip doesn't show as
                // already-expired on a slow refresh.
                expiresAt={new Date(new Date(m.createdAt).getTime() + 5 * 60 * 1000).toISOString()}
                conversationId={state.conversation?.id ?? ""}
              />
            );
          }
          return (
            <div key={m.id}>
              <AssistantBubble content={m.content} />
              <FeedbackBar messageId={m.id} />
            </div>
          );
        })}

        {state.error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2 text-sm text-red-800">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{state.error}</span>
          </div>
        )}
      </div>

      {/* Input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (state.sending || !input.trim()) return;
          const value = input;
          setInput("");
          send(value);
        }}
        className="border-t border-gray-200 p-4 bg-white"
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                (e.currentTarget.form as HTMLFormElement)?.requestSubmit();
              }
            }}
            placeholder={t("copilot.placeholder")}
            rows={2}
            disabled={state.sending || state.loading}
            className="flex-1 resize-none border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={state.sending || !input.trim()}
            className="bg-purple-600 text-white p-2.5 rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            title={t("copilot.send")}
          >
            {state.sending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
        <p className="text-[11px] text-gray-400 mt-1.5 leading-snug">
          {t("copilot.free_input_intro")}
        </p>
      </form>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] bg-purple-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
        {content}
      </div>
    </div>
  );
}

function AssistantBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] bg-white border border-gray-200 text-gray-900 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm">
        {content}
      </div>
    </div>
  );
}
