/**
 * Conversaciones (/dashboard/conversaciones): the receptionist's conversations,
 * read-only, for the owner and admins. The API is GET /virtual-receptionist/inbox
 * and its pause, resume and attended actions (receptionist-inbox.service.ts).
 *
 * No React and no Next imports, so lib/receptionist-inbox.spec.ts can run them.
 */

export const INBOX_CHANNELS = ["web", "whatsapp", "instagram", "facebook", "telegram"] as const;
export type InboxChannel = (typeof INBOX_CHANNELS)[number];

export const INBOX_VIEWS = ["all", "attention", "paused"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];

export type AttentionReason = "client_asked_person" | "assistant_could_not_answer";

export interface InboxAttention {
  reason: AttentionReason | null;
  at: string;
}

export interface InboxListItem {
  id: string;
  channel: InboxChannel;
  /** Her client file's name, the name she booked with, or her channel id. */
  name: string;
  clientId: string | null;
  lastActivityAt: string;
  totalMessages: number;
  lastMessage: { role: string; preview: string; at: string } | null;
  attention: InboxAttention | null;
  paused: boolean;
}

export interface InboxPage {
  total: number;
  page: number;
  pageSize: number;
  items: InboxListItem[];
}

export interface InboxConversation {
  id: string;
  channel: InboxChannel;
  name: string;
  clientId: string | null;
  createdAt: string;
  lastActivityAt: string;
  attention: InboxAttention | null;
  paused: boolean;
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>;
}

export interface InboxFilters {
  view?: InboxView;
  channel?: InboxChannel | "";
  q?: string;
  page?: number;
}

/** The query string for GET /virtual-receptionist/inbox, defaults left out. */
export function inboxQuery(filters: InboxFilters = {}): string {
  const params = new URLSearchParams();
  if (filters.view && filters.view !== "all") params.set("view", filters.view);
  if (filters.channel) params.set("channel", filters.channel);
  const q = filters.q?.trim();
  if (q) params.set("q", q.slice(0, 100));
  if (filters.page && filters.page > 1) params.set("page", String(Math.floor(filters.page)));
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** How many pages the list has (at least one, so "Página 1 de 1"). */
export function inboxPages(page: Pick<InboxPage, "total" | "pageSize">): number {
  return Math.max(1, Math.ceil(page.total / Math.max(1, page.pageSize)));
}

/** The translation key for why the salon was told; null when it was not. */
export function attentionKey(attention: InboxAttention | null | undefined): string | null {
  if (!attention) return null;
  return attention.reason === "client_asked_person"
    ? "receptionistInbox.attention.client_asked_person"
    : "receptionistInbox.attention.assistant_could_not_answer";
}

/** The conversation's place in the list after an action, without reloading it. */
export function withConversation(items: InboxListItem[], c: InboxConversation): InboxListItem[] {
  return items.map((item) => (item.id === c.id ? { ...item, paused: c.paused, attention: c.attention } : item));
}

/** A ?view= or ?channel= from the address bar, only when it is one we know. */
export function viewFrom(value: string | null | undefined): InboxView {
  return (INBOX_VIEWS as readonly string[]).includes(value ?? "") ? (value as InboxView) : "all";
}

export function channelFrom(value: string | null | undefined): InboxChannel | "" {
  return (INBOX_CHANNELS as readonly string[]).includes(value ?? "") ? (value as InboxChannel) : "";
}

/** Fired on window after an action, so the menu badge recounts. */
export const RECEPTIONIST_INBOX_CHANGED = "kira:receptionist-inbox-changed";
