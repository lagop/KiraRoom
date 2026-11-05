"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCircle2, Clock, Loader2, Plus, Trash2, XCircle } from "lucide-react";
import apiClient, { ApiError, WaitListEntry, WaitListNotifyResult } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { getCurrentUser } from "@/lib/utils";
import { isManager } from "@/lib/dashboard-nav";
import { WAIT_LIST_FILTERS, WAIT_LIST_STATUS_KEY, WaitListStatus, closedNote, isOpenStatus } from "@/lib/wait-list-status";
import { useTranslations } from "@/lib/use-translation";

/**
 * Wait-list for fully booked services. "Avisar" really sends the notice
 * (email, the salon's WhatsApp or SMS) with a link to book, and shows what
 * each channel did; when no channel can deliver, it says why instead of
 * marking the client as notified. Entries whose dates passed, or that sat
 * untouched for 90 days, close as "Caducado"; a client can also leave from
 * the "Ya no me interesa" link in the notice. Texts: messages "waitList".
 */

type T = ReturnType<typeof useTranslations>;

// "inApp": notices sent before client accounts were removed.
const CHANNELS = ["email", "whatsapp", "sms", "inApp"];

function errorText(t: T, err: unknown): string {
  if (err instanceof ApiError && err.status === 404 && /plan/i.test(err.message)) return err.message;
  if (err instanceof ApiError && err.status === 403) return t("waitList.errors.forbidden");
  return err instanceof Error && err.message ? err.message : t("waitList.errors.generic");
}

/** A channel's reason in Spanish; older notices stored the provider's own (English) error. */
const SPANISH_REASON = /^(el |la |lo |no |ya |meta |whatsapp )/i;
function reasonText(t: T, c: { status: string; reason?: string }): string | null {
  if (!c.reason) return null;
  if (SPANISH_REASON.test(c.reason)) return c.reason;
  return c.status === "failed" ? t("waitList.outcome.providerFailed") : null;
}

/** Today in the browser, for the date inputs' minimum. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Named = { id: string; name: string };

export default function WaitListPage() {
  const t = useTranslations();
  const dateFmt = t("waitList.dateFmt");
  // t is a new function on every render; load() reads the current one
  // without reloading the list each time.
  const tRef = useRef(t);
  tRef.current = t;
  const [entries, setEntries] = useState<WaitListEntry[]>([]);
  const [status, setStatus] = useState<string>("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channels, setChannels] = useState<{ email: boolean; sms: boolean; whatsapp: boolean; whatsappReason: string | null } | null>(null);
  const [autoNotify, setAutoNotify] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [notifying, setNotifying] = useState<WaitListEntry | null>(null);
  const [results, setResults] = useState<Record<string, WaitListNotifyResult>>({});
  // The entry about to be removed, confirmed in the panel's dialog.
  const [pendingRemove, setPendingRemove] = useState<WaitListEntry | null>(null);
  const [removing, setRemoving] = useState(false);
  // Read after mount (the server has no token). Only owner and admin change
  // the automatic notices; until the role is known nobody does.
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, []);
  const manager = isManager(role);

  const [services, setServices] = useState<Named[]>([]);
  const [professionals, setProfessionals] = useState<Named[]>([]);
  const [clients, setClients] = useState<Array<{ id: string; firstName: string; lastName: string; email?: string; phone?: string }>>([]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const all = await apiClient.getWaitList(status === "open" || status === "all" ? undefined : status);
      setEntries(status === "open" ? all.filter((e) => isOpenStatus(e.status)) : all);
      setError(null);
    } catch (err) {
      setError(errorText(tRef.current, err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    apiClient.getWaitListChannels().then(setChannels).catch(() => setChannels(null));
    apiClient.getWaitListSettings().then((s) => setAutoNotify(s.autoNotify)).catch(() => undefined);
    apiClient.getServices().then((s: any[]) => setServices(s.filter((x) => x.isActive !== false).map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined);
    // The whole team (the admin list is paginated and owner/admin only).
    apiClient
      .getProfessionalsPublic()
      .then((p: any[]) =>
        setProfessionals(
          p
            .filter((x) => x.isActive !== false)
            .map((x) => ({ id: x.id, name: `${x.firstName} ${x.lastName}`.trim() })),
        ),
      )
      .catch(() => undefined);
    apiClient.getClients().then((c: any[]) => setClients(c)).catch(() => undefined);
  }, []);

  const noChannel = channels && !channels.email && !channels.sms && !channels.whatsapp;

  const toggleAuto = async (value: boolean) => {
    try {
      const s = await apiClient.saveWaitListSettings(value);
      setAutoNotify(s.autoNotify);
    } catch (err) {
      setError(errorText(t, err));
    }
  };

  const setEntryStatus = async (e: WaitListEntry, s: "fulfilled" | "cancelled" | "waiting") => {
    try {
      await apiClient.updateWaitListEntry(e.id, { status: s });
      load();
    } catch (err) {
      setError(errorText(t, err));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">{t("waitList.title")}</h1>
          <p className="text-gray-600">{t("waitList.subtitle")}</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md inline-flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> {t("waitList.add")}
        </button>
      </div>

      {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {channels && (
        <div
          className={`rounded-md border p-3 text-sm ${
            noChannel ? "border-amber-200 bg-amber-50 text-amber-800" : "border-gray-200 bg-white text-gray-700"
          }`}
        >
          <p>
            {t("waitList.channels.title")} {t("waitList.channels.email")} {channels.email ? "✓" : "✗"} ·{" "}
            {t("waitList.channels.sms")} {channels.sms ? "✓" : "✗"} · {t("waitList.channels.whatsapp")}{" "}
            {channels.whatsapp ? "✓" : `✗ (${channels.whatsappReason ?? t("waitList.channels.unavailable")})`}
          </p>
          {noChannel && <p className="mt-1">{t("waitList.channels.none")}</p>}
        </div>
      )}

      {manager ? (
        <label className="flex items-start gap-2 rounded-md border border-gray-200 bg-white p-3 text-sm">
          <input type="checkbox" className="mt-1" checked={autoNotify} onChange={(e) => toggleAuto(e.target.checked)} />
          <span>
            {t("waitList.auto.label")}
            <span className="block text-gray-500">{t("waitList.auto.help")}</span>
          </span>
        </label>
      ) : (
        role && (
          <p className="rounded-md border border-gray-200 bg-white p-3 text-sm text-gray-600">
            {autoNotify ? t("waitList.auto.on") : t("waitList.auto.off")}
          </p>
        )
      )}

      <div className="flex flex-wrap gap-2 text-sm">
        {WAIT_LIST_FILTERS.map(([k, labelKey]) => (
          <button
            key={k}
            onClick={() => setStatus(k)}
            className={`px-3 py-1.5 rounded-full border ${
              status === k ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600"
            }`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg shadow">
        {loading ? (
          <div className="flex justify-center p-10">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
        ) : entries.length === 0 ? (
          <p className="p-10 text-center text-sm text-gray-500">{t("waitList.empty")}</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {entries.map((e) => (
              <li key={e.id} className="p-4 space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-900">
                      {e.client.firstName} {e.client.lastName}
                      <span
                        className={`ml-2 rounded px-2 py-0.5 text-xs ${
                          e.status === "notified"
                            ? "bg-blue-100 text-blue-700"
                            : e.status === "fulfilled"
                              ? "bg-green-100 text-green-700"
                              : e.status === "cancelled"
                                ? "bg-gray-100 text-gray-600"
                                : e.status === "expired"
                                  ? "bg-gray-100 text-gray-500 italic"
                                  : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {e.status in WAIT_LIST_STATUS_KEY ? t(WAIT_LIST_STATUS_KEY[e.status as WaitListStatus]) : e.status}
                        {e.notifyCount > 1 ? ` ×${e.notifyCount}` : ""}
                      </span>
                    </p>
                    <p className="text-sm text-gray-600">
                      {e.professionalName
                        ? t("waitList.entry.serviceWith", {
                            service: e.serviceName ?? t("waitList.entry.service"),
                            professional: e.professionalName,
                          })
                        : (e.serviceName ?? t("waitList.entry.service"))}{" "}
                      ·{" "}
                      {e.earliestDate || e.latestDate
                        ? `${e.earliestDate ? new Date(e.earliestDate).toLocaleDateString(dateFmt) : "…"} – ${
                            e.latestDate ? new Date(e.latestDate).toLocaleDateString(dateFmt) : "…"
                          }`
                        : t("waitList.entry.anyDate")}
                    </p>
                    <p className="text-xs text-gray-500">
                      {!e.contactHidden &&
                        `${e.client.email ?? t("waitList.entry.noEmail")} · ${e.client.phone ?? t("waitList.entry.noPhone")} · `}
                      {t("waitList.entry.since", { date: new Date(e.createdAt).toLocaleDateString(dateFmt) })}
                      {e.notifiedAt &&
                        ` · ${t("waitList.entry.lastNotice", { date: new Date(e.notifiedAt).toLocaleString(dateFmt) })}`}
                    </p>
                    {e.notes && <p className="text-xs text-gray-500">{t("waitList.entry.note", { note: e.notes })}</p>}
                    {closedNote(e) && <p className="text-xs text-gray-500">{t(closedNote(e)!)}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {(e.status === "waiting" || e.status === "notified") && (
                      <>
                        <button
                          onClick={() => setNotifying(e)}
                          className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
                        >
                          <Bell className="w-4 h-4" /> {t("waitList.actions.notify")}
                        </button>
                        <button
                          onClick={() => setEntryStatus(e, "fulfilled")}
                          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-green-700"
                        >
                          <CheckCircle2 className="w-4 h-4" /> {t("waitList.actions.booked")}
                        </button>
                        <button
                          onClick={() => setEntryStatus(e, "cancelled")}
                          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-gray-600"
                        >
                          <XCircle className="w-4 h-4" /> {t("waitList.actions.discard")}
                        </button>
                      </>
                    )}
                    {/* An entry whose dates passed is not reopened: add a new one with new dates. */}
                    {(e.status === "cancelled" ||
                      e.status === "fulfilled" ||
                      (e.status === "expired" && e.closedReason !== "window_passed")) && (
                      <button
                        onClick={() => setEntryStatus(e, "waiting")}
                        className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-gray-600"
                      >
                        <Clock className="w-4 h-4" /> {t("waitList.actions.reopen")}
                      </button>
                    )}
                    <button
                      aria-label={t("waitList.actions.remove")}
                      onClick={() => setPendingRemove(e)}
                      className="text-red-600 hover:text-red-800 p-1"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                <NoticeOutcome result={results[e.id]} entry={e} />
              </li>
            ))}
          </ul>
        )}
      </div>

      {showAdd && (
        <AddDialog
          services={services}
          professionals={professionals}
          clients={clients}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            load();
          }}
          onError={setError}
        />
      )}

      {notifying && (
        <NotifyDialog
          entry={notifying}
          professionals={professionals}
          onClose={() => setNotifying(null)}
          onDone={(r) => {
            setResults((prev) => ({ ...prev, [notifying.id]: r }));
            setNotifying(null);
            load();
          }}
          onError={setError}
        />
      )}

      <ConfirmDialog
        open={!!pendingRemove}
        title={
          pendingRemove
            ? t("waitList.remove.title", {
                name: `${pendingRemove.client.firstName} ${pendingRemove.client.lastName}`,
              })
            : ""
        }
        confirmLabel={t("waitList.remove.confirm")}
        destructive
        loading={removing}
        onCancel={() => setPendingRemove(null)}
        onConfirm={async () => {
          if (!pendingRemove) return;
          setRemoving(true);
          try {
            await apiClient.removeWaitListEntry(pendingRemove.id);
            load();
          } catch (err) {
            setError(errorText(t, err));
          } finally {
            setRemoving(false);
            setPendingRemove(null);
          }
        }}
      />
    </div>
  );
}

/** What the last notice did, channel by channel. */
function NoticeOutcome({ result, entry }: { result?: WaitListNotifyResult; entry: WaitListEntry }) {
  const t = useTranslations();
  const channels = result?.channels ?? entry.lastNotification?.channels;
  if (!channels) return null;
  const ok = result ? result.notified : channels.some((c) => c.channel !== "inApp" && c.status === "sent");
  return (
    <div className={`rounded-md p-2 text-xs ${ok ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-800"}`}>
      <p className="font-medium">
        {result?.summary ??
          (ok
            ? t(entry.lastNotification?.auto ? "waitList.outcome.sentAuto" : "waitList.outcome.sent")
            : t("waitList.outcome.notDelivered"))}
      </p>
      <ul className="mt-1 space-y-0.5">
        {channels.map((c) => (
          <li key={c.channel}>
            {CHANNELS.includes(c.channel) ? t(`waitList.channels.${c.channel}`) : c.channel}:{" "}
            {c.status === "sent"
              ? t("waitList.outcome.channelSent")
              : c.status === "failed"
                ? t("waitList.outcome.channelFailed")
                : t("waitList.outcome.channelSkipped")}
            {reasonText(t, c) ? ` (${reasonText(t, c)})` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotifyDialog({
  entry,
  professionals,
  onClose,
  onDone,
  onError,
}: {
  entry: WaitListEntry;
  professionals: Named[];
  onClose: () => void;
  onDone: (r: WaitListNotifyResult) => void;
  onError: (e: string | null) => void;
}) {
  const t = useTranslations();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [professionalId, setProfessionalId] = useState(entry.professionalId ?? "");
  const [sending, setSending] = useState(false);

  const send = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try {
      setSending(true);
      const r = await apiClient.notifyWaitListEntry(entry.id, {
        ...(date ? { date } : {}),
        ...(date && time ? { time } : {}),
        ...(professionalId ? { professionalId } : {}),
      });
      onError(null);
      onDone(r);
    } catch (err) {
      onError(errorText(t, err));
      onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <form onSubmit={send} className="w-full max-w-md space-y-4 rounded-lg bg-white p-6">
        <h2 className="text-lg font-semibold">
          {t("waitList.notify.title", { name: `${entry.client.firstName} ${entry.client.lastName}` })}
        </h2>
        <p className="text-sm text-gray-600">{t("waitList.notify.help")}</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            {t("waitList.notify.date")}
            <input type="date" value={date} min={todayIso()} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-md border px-2 py-1.5" />
          </label>
          <label className="text-sm">
            {t("waitList.notify.time")}
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={!date} className="mt-1 w-full rounded-md border px-2 py-1.5" />
          </label>
        </div>
        <label className="block text-sm">
          {t("waitList.notify.professional")}
          <select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)} className="mt-1 w-full rounded-md border px-2 py-1.5">
            <option value="">{t("waitList.notify.anyProfessional")}</option>
            {professionals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm">
            {t("waitList.notify.cancel")}
          </button>
          <button type="submit" disabled={sending} className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">
            {sending ? t("waitList.notify.sending") : t("waitList.notify.send")}
          </button>
        </div>
      </form>
    </div>
  );
}

function AddDialog({
  services,
  professionals,
  clients,
  onClose,
  onSaved,
  onError,
}: {
  services: Named[];
  professionals: Named[];
  clients: Array<{ id: string; firstName: string; lastName: string; email?: string; phone?: string }>;
  onClose: () => void;
  onSaved: () => void;
  onError: (e: string | null) => void;
}) {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const [clientId, setClientId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [earliestDate, setEarliest] = useState("");
  const [latestDate, setLatest] = useState("");
  const [notes, setNotes] = useState("");
  // One request per click: a double click used to add the client twice.
  const [saving, setSaving] = useState(false);

  const q = query.trim().toLowerCase();
  const matches = q
    ? clients.filter((c) => `${c.firstName} ${c.lastName} ${c.email ?? ""} ${c.phone ?? ""}`.toLowerCase().includes(q)).slice(0, 6)
    : [];
  const chosen = clients.find((c) => c.id === clientId);

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!clientId || !serviceId || saving) return;
    setSaving(true);
    try {
      await apiClient.addToWaitList({
        clientId,
        serviceId,
        ...(professionalId ? { professionalId } : {}),
        ...(earliestDate ? { earliestDate } : {}),
        ...(latestDate ? { latestDate } : {}),
        ...(notes ? { notes } : {}),
      });
      onError(null);
      onSaved();
    } catch (err) {
      onError(errorText(t, err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <form onSubmit={save} className="w-full max-w-md space-y-3 rounded-lg bg-white p-6">
        <h2 className="text-lg font-semibold">{t("waitList.addDialog.title")}</h2>
        {chosen ? (
          <p className="text-sm">
            {t("waitList.addDialog.client")} <strong>{chosen.firstName} {chosen.lastName}</strong>{" "}
            <button type="button" className="text-blue-600" onClick={() => setClientId("")}>
              {t("waitList.addDialog.change")}
            </button>
          </p>
        ) : (
          <div>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("waitList.addDialog.search")} className="w-full rounded-md border px-3 py-2 text-sm" />
            {matches.length > 0 && (
              <ul className="mt-1 divide-y rounded-md border text-sm">
                {matches.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => setClientId(c.id)} className="w-full px-3 py-1.5 text-left hover:bg-gray-50">
                      {c.firstName} {c.lastName} <span className="text-gray-500">{c.email ?? c.phone ?? ""}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <select required value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="w-full rounded-md border px-3 py-2 text-sm">
          <option value="">{t("waitList.addDialog.service")}</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)} className="w-full rounded-md border px-3 py-2 text-sm">
          <option value="">{t("waitList.addDialog.anyProfessional")}</option>
          {professionals.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label>
            {t("waitList.addDialog.from")}
            <input type="date" value={earliestDate} min={todayIso()} onChange={(e) => setEarliest(e.target.value)} className="mt-1 w-full rounded-md border px-2 py-1.5" />
          </label>
          <label>
            {t("waitList.addDialog.to")}
            <input type="date" value={latestDate} min={earliestDate || todayIso()} onChange={(e) => setLatest(e.target.value)} className="mt-1 w-full rounded-md border px-2 py-1.5" />
          </label>
        </div>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder={t("waitList.addDialog.notePlaceholder")} className="w-full rounded-md border px-3 py-2 text-sm" />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm">
            {t("waitList.addDialog.cancel")}
          </button>
          <button type="submit" disabled={!clientId || !serviceId || saving} className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">
            {saving ? t("waitList.addDialog.adding") : t("waitList.addDialog.add")}
          </button>
        </div>
      </form>
    </div>
  );
}
