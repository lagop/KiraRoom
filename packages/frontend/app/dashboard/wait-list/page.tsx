"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, CheckCircle2, Clock, Loader2, Plus, Trash2, XCircle } from "lucide-react";
import apiClient, { ApiError, WaitListEntry, WaitListNotifyResult } from "@/lib/api";

/**
 * Wait-list for fully booked services. "Avisar" really sends the notice
 * (email, the salon's WhatsApp or SMS) with a link to book, and shows what
 * each channel did; when no channel can deliver, it says why instead of
 * marking the client as notified.
 */

const STATUS_LABEL: Record<WaitListEntry["status"], string> = {
  waiting: "Esperando",
  notified: "Avisado",
  fulfilled: "Ha reservado",
  cancelled: "Descartado",
};

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  sms: "SMS",
  inApp: "Área de cliente",
};

function errorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 404 && /plan/i.test(err.message)) return err.message;
  return err instanceof Error && err.message ? err.message : "Algo ha fallado. Inténtalo de nuevo.";
}

type Named = { id: string; name: string };

export default function WaitListPage() {
  const [entries, setEntries] = useState<WaitListEntry[]>([]);
  const [status, setStatus] = useState<string>("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channels, setChannels] = useState<{ email: boolean; sms: boolean; whatsapp: boolean; whatsappReason: string | null } | null>(null);
  const [autoNotify, setAutoNotify] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [notifying, setNotifying] = useState<WaitListEntry | null>(null);
  const [results, setResults] = useState<Record<string, WaitListNotifyResult>>({});

  const [services, setServices] = useState<Named[]>([]);
  const [professionals, setProfessionals] = useState<Named[]>([]);
  const [clients, setClients] = useState<Array<{ id: string; firstName: string; lastName: string; email?: string; phone?: string }>>([]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const all = await apiClient.getWaitList(status === "open" || status === "all" ? undefined : status);
      setEntries(status === "open" ? all.filter((e) => e.status === "waiting" || e.status === "notified") : all);
      setError(null);
    } catch (err) {
      setError(errorText(err));
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
    apiClient.getServices().then((s: any[]) => setServices(s.map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined);
    apiClient
      .getProfessionals()
      .then((p: any[]) => setProfessionals(p.map((x) => ({ id: x.id, name: `${x.firstName} ${x.lastName}`.trim() }))))
      .catch(() => undefined);
    apiClient.getClients().then((c: any[]) => setClients(c)).catch(() => undefined);
  }, []);

  const noChannel = channels && !channels.email && !channels.sms && !channels.whatsapp;

  const toggleAuto = async (value: boolean) => {
    try {
      const s = await apiClient.saveWaitListSettings(value);
      setAutoNotify(s.autoNotify);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const setEntryStatus = async (e: WaitListEntry, s: "fulfilled" | "cancelled" | "waiting") => {
    try {
      await apiClient.updateWaitListEntry(e.id, { status: s });
      load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">Lista de espera</h1>
          <p className="text-gray-600">
            Clientes que quieren un hueco que ahora está lleno. Cuando se libere, avísales con un
            enlace para reservarlo.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md inline-flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> Añadir a la lista
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
            Canales para avisar: Email {channels.email ? "✓" : "✗"} · SMS {channels.sms ? "✓" : "✗"} · WhatsApp{" "}
            {channels.whatsapp ? "✓" : `✗ (${channels.whatsappReason ?? "no disponible"})`}
          </p>
          {noChannel && (
            <p className="mt-1">
              Ahora mismo no se puede avisar a nadie: falta configurar un proveedor de email o SMS, o
              conectar el WhatsApp del salón en Ajustes → WhatsApp. "Avisar" te dirá qué ha pasado
              con cada canal.
            </p>
          )}
        </div>
      )}

      <label className="flex items-start gap-2 rounded-md border border-gray-200 bg-white p-3 text-sm">
        <input type="checkbox" className="mt-1" checked={autoNotify} onChange={(e) => toggleAuto(e.target.checked)} />
        <span>
          Avisar automáticamente cuando se cancela una cita.
          <span className="block text-gray-500">
            Se avisa a los 3 primeros clientes que esperan ese servicio y cuyas fechas encajan, por
            orden de llegada. Si está desactivado, te llega un aviso en el panel para que decidas tú.
          </span>
        </span>
      </label>

      <div className="flex flex-wrap gap-2 text-sm">
        {[
          ["open", "Pendientes"],
          ["fulfilled", "Han reservado"],
          ["cancelled", "Descartados"],
          ["all", "Todos"],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setStatus(k)}
            className={`px-3 py-1.5 rounded-full border ${
              status === k ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg shadow">
        {loading ? (
          <div className="flex justify-center p-10">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          </div>
        ) : entries.length === 0 ? (
          <p className="p-10 text-center text-sm text-gray-500">No hay nadie en la lista.</p>
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
                                : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {STATUS_LABEL[e.status]}
                        {e.notifyCount > 1 ? ` ×${e.notifyCount}` : ""}
                      </span>
                    </p>
                    <p className="text-sm text-gray-600">
                      {e.serviceName ?? "Servicio"}
                      {e.professionalName ? ` con ${e.professionalName}` : ""} ·{" "}
                      {e.earliestDate || e.latestDate
                        ? `${e.earliestDate ? new Date(e.earliestDate).toLocaleDateString("es-ES") : "…"} – ${
                            e.latestDate ? new Date(e.latestDate).toLocaleDateString("es-ES") : "…"
                          }`
                        : "cualquier fecha"}
                    </p>
                    <p className="text-xs text-gray-500">
                      {e.client.email ?? "sin email"} · {e.client.phone ?? "sin teléfono"} · en la lista desde{" "}
                      {new Date(e.createdAt).toLocaleDateString("es-ES")}
                      {e.notifiedAt && ` · último aviso ${new Date(e.notifiedAt).toLocaleString("es-ES")}`}
                    </p>
                    {e.notes && <p className="text-xs text-gray-500">Nota: {e.notes}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {(e.status === "waiting" || e.status === "notified") && (
                      <>
                        <button
                          onClick={() => setNotifying(e)}
                          className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
                        >
                          <Bell className="w-4 h-4" /> Avisar
                        </button>
                        <button
                          onClick={() => setEntryStatus(e, "fulfilled")}
                          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-green-700"
                        >
                          <CheckCircle2 className="w-4 h-4" /> Ha reservado
                        </button>
                        <button
                          onClick={() => setEntryStatus(e, "cancelled")}
                          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-gray-600"
                        >
                          <XCircle className="w-4 h-4" /> Descartar
                        </button>
                      </>
                    )}
                    {(e.status === "cancelled" || e.status === "fulfilled") && (
                      <button
                        onClick={() => setEntryStatus(e, "waiting")}
                        className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-gray-600"
                      >
                        <Clock className="w-4 h-4" /> Volver a la lista
                      </button>
                    )}
                    <button
                      aria-label="Eliminar"
                      onClick={async () => {
                        if (!confirm("¿Eliminar de la lista de espera?")) return;
                        try {
                          await apiClient.removeWaitListEntry(e.id);
                          load();
                        } catch (err) {
                          setError(errorText(err));
                        }
                      }}
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
    </div>
  );
}

/** What the last notice did, channel by channel. */
function NoticeOutcome({ result, entry }: { result?: WaitListNotifyResult; entry: WaitListEntry }) {
  const channels = result?.channels ?? entry.lastNotification?.channels;
  if (!channels) return null;
  const ok = result ? result.notified : channels.some((c) => c.channel !== "inApp" && c.status === "sent");
  return (
    <div className={`rounded-md p-2 text-xs ${ok ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-800"}`}>
      <p className="font-medium">
        {result?.summary ??
          (ok
            ? `Último aviso enviado${entry.lastNotification?.auto ? " automáticamente" : ""}`
            : "El último intento no llegó a ningún canal")}
      </p>
      <ul className="mt-1 space-y-0.5">
        {channels.map((c) => (
          <li key={c.channel}>
            {CHANNEL_LABEL[c.channel] ?? c.channel}:{" "}
            {c.status === "sent" ? "enviado" : c.status === "failed" ? "falló" : "no enviado"}
            {c.reason ? ` (${c.reason})` : ""}
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
      onError(errorText(err));
      onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <form onSubmit={send} className="w-full max-w-md space-y-4 rounded-lg bg-white p-6">
        <h2 className="text-lg font-semibold">
          Avisar a {entry.client.firstName} {entry.client.lastName}
        </h2>
        <p className="text-sm text-gray-600">
          Recibirá un mensaje con el hueco que indiques y un enlace para reservarlo en tu web. Si no
          indicas fecha, el mensaje dirá que hay huecos disponibles.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            Fecha
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-md border px-2 py-1.5" />
          </label>
          <label className="text-sm">
            Hora
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={!date} className="mt-1 w-full rounded-md border px-2 py-1.5" />
          </label>
        </div>
        <label className="block text-sm">
          Profesional
          <select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)} className="mt-1 w-full rounded-md border px-2 py-1.5">
            <option value="">Cualquiera</option>
            {professionals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm">
            Cancelar
          </button>
          <button type="submit" disabled={sending} className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">
            {sending ? "Enviando…" : "Enviar aviso"}
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
  const [query, setQuery] = useState("");
  const [clientId, setClientId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [earliestDate, setEarliest] = useState("");
  const [latestDate, setLatest] = useState("");
  const [notes, setNotes] = useState("");

  const q = query.trim().toLowerCase();
  const matches = q
    ? clients.filter((c) => `${c.firstName} ${c.lastName} ${c.email ?? ""} ${c.phone ?? ""}`.toLowerCase().includes(q)).slice(0, 6)
    : [];
  const chosen = clients.find((c) => c.id === clientId);

  const save = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!clientId || !serviceId) return;
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
      onError(errorText(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <form onSubmit={save} className="w-full max-w-md space-y-3 rounded-lg bg-white p-6">
        <h2 className="text-lg font-semibold">Añadir a la lista de espera</h2>
        {chosen ? (
          <p className="text-sm">
            Cliente: <strong>{chosen.firstName} {chosen.lastName}</strong>{" "}
            <button type="button" className="text-blue-600" onClick={() => setClientId("")}>
              cambiar
            </button>
          </p>
        ) : (
          <div>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Busca al cliente" className="w-full rounded-md border px-3 py-2 text-sm" />
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
          <option value="">Servicio</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)} className="w-full rounded-md border px-3 py-2 text-sm">
          <option value="">Cualquier profesional</option>
          {professionals.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label>
            Desde
            <input type="date" value={earliestDate} onChange={(e) => setEarliest(e.target.value)} className="mt-1 w-full rounded-md border px-2 py-1.5" />
          </label>
          <label>
            Hasta
            <input type="date" value={latestDate} onChange={(e) => setLatest(e.target.value)} className="mt-1 w-full rounded-md border px-2 py-1.5" />
          </label>
        </div>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Nota (opcional): mejor por la tarde…" className="w-full rounded-md border px-3 py-2 text-sm" />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md border px-4 py-2 text-sm">
            Cancelar
          </button>
          <button type="submit" disabled={!clientId || !serviceId} className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">
            Añadir
          </button>
        </div>
      </form>
    </div>
  );
}
