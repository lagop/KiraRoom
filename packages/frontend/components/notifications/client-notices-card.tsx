"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import apiClient, { ClientNoticesState, NoticeChannel } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { choiceOrigin } from "@/components/marketing/client-marketing-card";

const CHANNELS: Array<{ key: NoticeChannel; label: string }> = [
  { key: "email", label: "Email" },
  { key: "sms", label: "SMS" },
  { key: "whatsapp", label: "WhatsApp" },
];

/** Why a channel cannot be used for her today, if it cannot. */
function unavailable(state: ClientNoticesState, channel: NoticeChannel): string | null {
  if (channel === "email" && !state.contact.email) return "Sin email en su ficha";
  if (channel !== "email" && !state.contact.phone) return "Sin teléfono en su ficha";
  if (channel === "sms" && !state.available.sms) return "El envío de SMS no está activado";
  if (channel === "whatsapp" && !state.available.whatsapp) return "Conecta el WhatsApp del salón en Ajustes";
  return null;
}

/**
 * How the client gets the notices of her appointments (confirmation,
 * changes, reminders), on her file. Clients have no account to choose it
 * themselves, so the team sets it here. WhatsApp is on only when she asks
 * for it (the box when booking online, or telling the salon): turning it on
 * here asks the team member to confirm she did, and the record says who.
 */
export function ClientNoticesCard({ clientId }: { clientId: string }) {
  const { toast } = useToast();
  const [state, setState] = useState<ClientNoticesState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState<NoticeChannel | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [asked, setAsked] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await apiClient.getClientNotices(clientId));
    } catch {
      setHidden(true);
    }
  }, [clientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(channel: NoticeChannel, on: boolean, clientAsked = false) {
    setBusy(channel);
    try {
      setState(await apiClient.setClientNotices(clientId, { [channel]: on, ...(clientAsked ? { clientAsked } : {}) }));
      setConfirming(false);
      setAsked(false);
      const name = CHANNELS.find((c) => c.key === channel)?.label ?? channel;
      toast({ title: on ? `Avisos de citas por ${name}: activados` : `Avisos de citas por ${name}: desactivados` });
    } catch (err: any) {
      toast({ title: "No se pudo guardar", description: err?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  if (hidden) return null;

  const request = state?.whatsappRequest;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
        <BellRing className="h-4 w-4 text-purple-600" /> Avisos de sus citas
      </h2>
      <p className="mt-1 text-sm text-gray-500">
        Confirmación, cambios y recordatorios. La clienta no tiene cuenta en la web: si te pide cambiar cómo
        los recibe, hazlo aquí.
      </p>
      {!state ? (
        <Loader2 className="mt-3 h-4 w-4 animate-spin text-gray-400" />
      ) : (
        <ul className="mt-4 space-y-3 text-sm">
          {CHANNELS.map(({ key, label }) => {
            const on = state.channels[key];
            const why = unavailable(state, key);
            return (
              <li key={key} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-gray-700">{label}</span>
                  <div className="flex items-center gap-2">
                    <span className={on ? "text-green-700" : "text-gray-500"}>{on ? "Activados" : "Desactivados"}</span>
                    {on ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => save(key, false)}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        {busy === key ? <Loader2 className="h-3 w-3 animate-spin" /> : "Desactivar"}
                      </button>
                    ) : key === "whatsapp" ? (
                      !why &&
                      !confirming && (
                        <button
                          type="button"
                          onClick={() => setConfirming(true)}
                          className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                        >
                          Activar
                        </button>
                      )
                    ) : (
                      !why && (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => save(key, true)}
                          className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          {busy === key ? <Loader2 className="h-3 w-3 animate-spin" /> : "Activar"}
                        </button>
                      )
                    )}
                  </div>
                </div>
                {why && <p className="text-xs text-gray-500">{why}</p>}
                {key === "whatsapp" && request && request.status !== "none" && (
                  <p className="text-xs text-gray-500">
                    {request.status === "granted" ? "Lo pidió" : "Dejó de quererlo"}
                    {request.decidedAt ? ` el ${new Date(request.decidedAt).toLocaleDateString("es-ES")}` : ""}
                    {choiceOrigin(request.source)}
                  </p>
                )}
                {key === "whatsapp" && confirming && (
                  <div className="mt-1 space-y-2 rounded-lg bg-gray-50 p-3">
                    <label className="flex items-start gap-2 text-xs text-gray-700">
                      <input
                        type="checkbox"
                        checked={asked}
                        onChange={(e) => setAsked(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        La clienta lo ha pedido: quiere recibir los avisos de sus citas por WhatsApp. Quedará
                        anotado con mi nombre.
                      </span>
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={!asked || busy !== null}
                        onClick={() => save("whatsapp", true, true)}
                        className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        Guardar
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirming(false);
                          setAsked(false);
                        }}
                        className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-white"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
