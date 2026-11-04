"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowLeft, Bot, Loader2, MessageCircle, Pause, Play, Search } from "lucide-react";
import apiClient from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";
import {
  INBOX_CHANNELS,
  INBOX_VIEWS,
  RECEPTIONIST_INBOX_CHANGED,
  attentionKey,
  channelFrom,
  inboxPages,
  viewFrom,
  withConversation,
  type InboxChannel,
  type InboxConversation,
  type InboxPage,
  type InboxView,
} from "@/lib/receptionist-inbox";

const errorText = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Conversaciones (audit D15): what clients talked about with the virtual
 * receptionist, every channel, newest first. Read-only: nobody replies from
 * here. The salon pauses the assistant in one conversation (it then stores
 * her messages and does not answer, on every channel), resumes it, and marks
 * as attended the ones it was told about (she asked for a person, or the
 * assistant could not answer). Owner and admins, like the API.
 */
function ConversationsPage() {
  const t = useTranslations();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get("c");

  const [view, setView] = useState<InboxView>(() => viewFrom(searchParams.get("view")));
  const [channel, setChannel] = useState<InboxChannel | "">(() => channelFrom(searchParams.get("channel")));
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<InboxPage | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);

  const [conversation, setConversation] = useState<InboxConversation | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [confirming, setConfirming] = useState<"pause" | "resume" | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      setList(await apiClient.getReceptionistInbox({ view, channel, q: search, page }));
    } catch (err) {
      setListError(errorText(err, t("receptionistInbox.loadError")));
    } finally {
      setListLoading(false);
    }
  }, [view, channel, search, page, t]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // The search runs once she stops typing.
  useEffect(() => {
    const id = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    if (!selectedId) {
      setConversation(null);
      setConversationError(null);
      return;
    }
    let live = true;
    setConversationLoading(true);
    setConversationError(null);
    apiClient
      .getReceptionistConversation(selectedId)
      .then((c) => {
        if (live) setConversation(c);
      })
      .catch((err) => {
        if (!live) return;
        setConversation(null);
        setConversationError(
          (err as { status?: number })?.status === 404
            ? t("receptionistInbox.notFound")
            : errorText(err, t("receptionistInbox.loadError")),
        );
      })
      .finally(() => {
        if (live) setConversationLoading(false);
      });
    return () => {
      live = false;
    };
  }, [selectedId, t]);

  const open = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("c", id);
    else params.delete("c");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const applied = (c: InboxConversation) => {
    setConversation(c);
    setList((l) => (l ? { ...l, items: withConversation(l.items, c) } : l));
    window.dispatchEvent(new Event(RECEPTIONIST_INBOX_CHANGED));
  };

  const pauseOrResume = async () => {
    if (!conversation || !confirming) return;
    setBusy(true);
    try {
      if (confirming === "pause") {
        applied(await apiClient.pauseReceptionistConversation(conversation.id));
        toast({ title: t("receptionistInbox.pausedToast"), description: t("receptionistInbox.pausedToastBody") });
      } else {
        applied(await apiClient.resumeReceptionistConversation(conversation.id));
        toast({ title: t("receptionistInbox.resumedToast") });
      }
      setConfirming(null);
    } catch (err) {
      toast({ title: t("receptionistInbox.actionError"), description: errorText(err, ""), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const markAttended = async () => {
    if (!conversation) return;
    setBusy(true);
    try {
      applied(await apiClient.markReceptionistConversationAttended(conversation.id));
      toast({ title: t("receptionistInbox.attendedToast") });
    } catch (err) {
      toast({ title: t("receptionistInbox.actionError"), description: errorText(err, ""), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const filtered = view !== "all" || !!channel || !!search;
  const pages = list ? inboxPages(list) : 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 truncate">{t("receptionistInbox.title")}</h1>
        <p className="text-gray-500 mt-1">{t("receptionistInbox.subtitle")}</p>
        <p className="text-sm text-gray-500 mt-1">{t("receptionistInbox.readOnly")}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        {/* The list: hidden on a phone while a conversation is open. */}
        <section className={`space-y-3 ${selectedId ? "hidden lg:block" : ""}`} aria-label={t("receptionistInbox.title")}>
          <div className="flex flex-wrap gap-2" role="group">
            {INBOX_VIEWS.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => {
                  setView(v);
                  setPage(1);
                }}
                className={`rounded-full px-3 py-1 text-sm border ${
                  view === v ? "bg-purple-600 text-white border-purple-600" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                }`}
              >
                {t(`receptionistInbox.views.${v}`)}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative flex-1">
              <span className="sr-only">{t("receptionistInbox.search")}</span>
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-400" aria-hidden="true" />
              <input
                type="search"
                value={query}
                maxLength={100}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("receptionistInbox.searchPlaceholder")}
                className="w-full rounded-md border border-gray-300 py-2 pl-8 pr-2 text-sm"
              />
            </label>
            <select
              value={channel}
              onChange={(e) => {
                setChannel(channelFrom(e.target.value));
                setPage(1);
              }}
              aria-label={t("receptionistInbox.channelAll")}
              className="rounded-md border border-gray-300 px-2 py-2 text-sm"
            >
              <option value="">{t("receptionistInbox.channelAll")}</option>
              {INBOX_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {t(`receptionistInbox.channels.${c}`)}
                </option>
              ))}
            </select>
          </div>

          {listError ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <p>{listError}</p>
              <button type="button" onClick={() => void loadList()} className="mt-2 font-medium underline">
                {t("receptionistInbox.retry")}
              </button>
            </div>
          ) : listLoading && !list ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" aria-hidden="true" />
            </div>
          ) : list && list.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
              {filtered ? t("receptionistInbox.emptyFiltered") : t("receptionistInbox.empty")}
            </p>
          ) : (
            <ul className={`divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white ${listLoading ? "opacity-60" : ""}`}>
              {list?.items.map((item) => {
                const reason = attentionKey(item.attention);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => open(item.id)}
                      aria-current={item.id === selectedId ? "true" : undefined}
                      className={`w-full px-4 py-3 text-left hover:bg-gray-50 ${item.id === selectedId ? "bg-purple-50" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-gray-900">{item.name}</span>
                        <span className="shrink-0 text-xs text-gray-500">{when(item.lastActivityAt)}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-700">
                          {t(`receptionistInbox.channels.${item.channel}`)}
                        </span>
                        {reason && (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                            {t(reason)}
                          </span>
                        )}
                        {item.paused && (
                          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-white">{t("receptionistInbox.pausedBadge")}</span>
                        )}
                        <span className="text-gray-500">{t("receptionistInbox.messageCount", { count: item.totalMessages })}</span>
                      </div>
                      {item.lastMessage && (
                        <p className="mt-1 line-clamp-2 text-sm text-gray-600">{item.lastMessage.preview}</p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {list && pages > 1 && (
            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                disabled={page <= 1 || listLoading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-md border border-gray-300 px-3 py-1.5 disabled:opacity-50"
              >
                {t("receptionistInbox.previous")}
              </button>
              <span className="text-gray-600">{t("receptionistInbox.pageOf", { page, pages })}</span>
              <button
                type="button"
                disabled={page >= pages || listLoading}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                className="rounded-md border border-gray-300 px-3 py-1.5 disabled:opacity-50"
              >
                {t("receptionistInbox.next")}
              </button>
            </div>
          )}
        </section>

        {/* The conversation. */}
        <section className={`${selectedId ? "" : "hidden lg:block"}`}>
          {!selectedId ? (
            <div className="flex h-full min-h-[12rem] flex-col items-center justify-center rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
              <MessageCircle className="mb-2 h-8 w-8 text-gray-300" aria-hidden="true" />
              {t("receptionistInbox.select")}
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-white">
              <div className="border-b border-gray-200 p-4 space-y-3">
                <button
                  type="button"
                  onClick={() => open(null)}
                  className="inline-flex items-center gap-1 text-sm text-purple-700 hover:underline lg:hidden"
                >
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  {t("receptionistInbox.back")}
                </button>
                {conversationLoading && !conversation ? (
                  <Loader2 className="h-5 w-5 animate-spin text-gray-400" aria-hidden="true" />
                ) : conversationError ? (
                  <p className="text-sm text-red-700">{conversationError}</p>
                ) : conversation ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <h2 className="truncate text-lg font-semibold text-gray-900">{conversation.name}</h2>
                        <p className="text-xs text-gray-500">
                          {t(`receptionistInbox.channels.${conversation.channel}`)} · {when(conversation.lastActivityAt)}
                        </p>
                      </div>
                      {conversation.clientId && (
                        <Link href={`/dashboard/clients/${conversation.clientId}`} className="text-sm text-purple-700 hover:underline">
                          {t("receptionistInbox.clientFile")}
                        </Link>
                      )}
                    </div>
                    {conversation.attention && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900">
                        <span className="inline-flex items-center gap-1.5">
                          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                          {t(attentionKey(conversation.attention)!)} · {when(conversation.attention.at)}
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void markAttended()}
                          className="rounded-md border border-amber-300 bg-white px-3 py-1.5 font-medium hover:bg-amber-100 disabled:opacity-50"
                        >
                          {t("receptionistInbox.markAttended")}
                        </button>
                      </div>
                    )}
                    {conversation.paused && (
                      <p className="rounded-md bg-gray-100 p-3 text-sm text-gray-700">{t("receptionistInbox.pausedNote")}</p>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirming(conversation.paused ? "resume" : "pause")}
                      className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {conversation.paused ? <Play className="h-4 w-4" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}
                      {conversation.paused ? t("receptionistInbox.resume") : t("receptionistInbox.pause")}
                    </button>
                  </>
                ) : null}
              </div>
              {conversation && (
                <ol className="max-h-[60vh] space-y-3 overflow-y-auto bg-gray-50 p-4" aria-label={conversation.name}>
                  {conversation.messages.map((m) => {
                    const fromClient = m.role === "user";
                    return (
                      <li key={m.id} className={`flex ${fromClient ? "justify-start" : "justify-end"}`}>
                        <div
                          className={`max-w-[85%] rounded-lg px-3 py-2 text-sm shadow-sm ${
                            fromClient ? "bg-white text-gray-800" : "bg-purple-600 text-white"
                          }`}
                        >
                          <p className={`mb-0.5 flex items-center gap-1 text-xs ${fromClient ? "text-gray-500" : "text-purple-100"}`}>
                            {!fromClient && <Bot className="h-3 w-3" aria-hidden="true" />}
                            {fromClient ? t("receptionistInbox.you") : t("receptionistInbox.assistant")} · {when(m.createdAt)}
                          </p>
                          <p className="whitespace-pre-wrap break-words">{m.content}</p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={!!confirming}
        title={confirming === "resume" ? t("receptionistInbox.resumeTitle") : t("receptionistInbox.pauseTitle")}
        description={confirming === "resume" ? t("receptionistInbox.resumeBody") : t("receptionistInbox.pauseBody")}
        confirmLabel={confirming === "resume" ? t("receptionistInbox.resumeConfirm") : t("receptionistInbox.pauseConfirm")}
        cancelLabel={t("receptionistInbox.cancel")}
        loading={busy}
        onCancel={() => setConfirming(null)}
        onConfirm={() => void pauseOrResume()}
      />
    </div>
  );
}

// useSearchParams() needs a Suspense boundary for the page to prerender.
export default function ConversationsRoute() {
  return (
    <Suspense fallback={null}>
      <ConversationsPage />
    </Suspense>
  );
}
