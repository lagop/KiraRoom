"use client";

/**
 * P2A-staff-copilot: polling-based conversation hook.
 *
 * The panel polls /assistant/messages every 1.5 s while the user is
 * waiting for the assistant to finish; on a settled reply
 * (lastRole === 'assistant' and no pendingApprovals) the polling
 * stops. We don't use SSE/WebSocket in sprint 12 — polling is
 * cheap and the typical reply is sub-second.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import apiClient, {
  AssistantMessage,
  AssistantConversation,
  AssistantSendResponse,
  SendAssistantMessageDto,
} from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";

export interface ChatState {
  conversation: AssistantConversation | null;
  messages: AssistantMessage[];
  loading: boolean;
  sending: boolean;
  error: string | null;
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

export function useCopilotConversation() {
  const user = getCurrentUser();
  const tenantId: string = user?.tenantId ?? '';
  const [state, setState] = useState<ChatState>({
    conversation: null,
    messages: [],
    loading: true,
    sending: false,
    error: null,
  });
  const [tier, setTier] = useState<'free' | 'pro' | 'premium' | null>(null);
  const [costCapReached, setCostCapReached] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadline = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const fetchMessages = useCallback(
    async (conversationId: string) => {
      try {
        const messages = await apiClient.listAssistantMessages(
          conversationId,
        );
        setState((s) => ({ ...s, messages, loading: false }));
      } catch (err) {
        stopPolling();
        setState((s) => ({
          ...s,
          error: (err as Error)?.message ?? "Error",
          loading: false,
        }));
      }
    },
    [stopPolling],
  );

  /**
   * Poll until the latest message is an assistant reply AND there
   * are no pending approvals. Stops early if the deadline (60 s) is
   * reached — the LLM might be slow but the user shouldn't wait
   * forever.
   */
  const startPolling = useCallback(
    (conversationId: string) => {
      stopPolling();
      pollDeadline.current = Date.now() + POLL_TIMEOUT_MS;
      pollTimer.current = setInterval(async () => {
        if (Date.now() > pollDeadline.current) {
          stopPolling();
          return;
        }
        await fetchMessages(conversationId);
      }, POLL_INTERVAL_MS);
    },
    [fetchMessages, stopPolling],
  );

  // The hook reads `state.messages` from the closure; we also keep a
  // ref so the polling callback can inspect the latest settled state
  // without re-creating the interval on every render.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    stopPolling();
  }, [stopPolling]);

  const bootstrap = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      // P2A-staff-copilot-sprint15: load the tenant's effective tier
      // first so the panel can render the upgrade prompt before any
      // other call. Failures here are non-fatal (we still try to
      // bootstrap the conversation and surface the error there).
      try {
        const t = await apiClient.getAssistantTier();
        setTier(t.tier);
      } catch {
        setTier('free');
      }

      // P2A-staff-copilot-sprint12: one persistent thread per
      // (user, tenant) for now. Sprint 14+ supports multiple panels
      // per user via `sessionId`.
      const list = await apiClient.listAssistantConversations();
      let convo: AssistantConversation;
      if (list.length > 0) {
        convo = list[0];
      } else {
        convo = await apiClient.createAssistantConversation({});
      }
      setState((s) => ({ ...s, conversation: convo }));
      await fetchMessages(convo.id);
    } catch (err) {
      setState((s) => ({
        ...s,
        error: (err as Error)?.message ?? "Error",
        loading: false,
      }));
    }
  }, [fetchMessages]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  /**
   * Send a user message. The backend returns the assistant's
   * immediate response (with `toolsExecuted` etc.) and we
   * optimistically append the user message + the reply to the local
   * list. The polling loop catches any further tool calls.
   */
  const send = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      if (costCapReached) {
        setState((s) => ({ ...s, error: "Has alcanzado el límite mensual del copiloto." }));
        return;
      }
      if (!state.conversation) {
        setState((s) => ({ ...s, error: "Conversation not ready" }));
        return;
      }
      setState((s) => ({ ...s, sending: true, error: null }));
      // Optimistic user message so the UI feels instant.
      const optimisticUser: AssistantMessage = {
        id: `tmp-${Date.now()}`,
        conversationId: state.conversation.id,
        role: "user",
        content: trimmed,
        createdAt: new Date().toISOString(),
      };
      setState((s) => ({
        ...s,
        messages: [...s.messages, optimisticUser],
      }));
      try {
        const dto: SendAssistantMessageDto = { content: trimmed };
        const reply: AssistantSendResponse =
          await apiClient.sendAssistantMessage(state.conversation.id, dto);
        if ((reply as any).costCapReached) {
          setCostCapReached(true);
        }
        setState((s) => ({
          ...s,
          sending: false,
          conversation: reply.conversation ?? s.conversation,
          messages: [
            ...s.messages.filter((m) => m.id !== optimisticUser.id),
            reply.message,
          ],
        }));
        // If the reply references further tool calls, keep polling.
        if (reply.toolsExecuted.length > 0 || reply.pendingApprovals.length > 0) {
          startPolling(reply.conversation.id);
        } else {
          // A small extra poll to catch any straggling tool calls.
          startPolling(reply.conversation.id);
          setTimeout(() => stopPolling(), 2500);
        }
      } catch (err) {
        setState((s) => ({
          ...s,
          sending: false,
          error: (err as Error)?.message ?? "Error sending",
          messages: s.messages.filter((m) => m.id !== optimisticUser.id),
        }));
      }
    },
    [state.conversation, startPolling, stopPolling, costCapReached],
  );

  const clear = useCallback(async () => {
    try {
      const fresh = await apiClient.createAssistantConversation({});
      setState({
        conversation: fresh,
        messages: [],
        loading: false,
        sending: false,
        error: null,
      });
    } catch (err) {
      setState((s) => ({ ...s, error: (err as Error)?.message ?? "Error" }));
    }
  }, []);

  return { state, send, clear, tenantId, tier, costCapReached };
}
