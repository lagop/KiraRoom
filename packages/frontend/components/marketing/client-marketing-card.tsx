"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Megaphone } from "lucide-react";
import apiClient, { MarketingConsentState } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

function when(state: MarketingConsentState) {
  return state.decidedAt ? new Date(state.decidedAt).toLocaleDateString("es-ES") : "";
}

function describe(state: MarketingConsentState, channel: "email" | "whatsapp") {
  if (state.status === "granted") return `Acepta (desde el ${when(state)})`;
  if (state.status === "refused") return `No quiere (desde el ${when(state)})`;
  return channel === "email"
    ? "No lo ha indicado: puede recibirlas como cliente hasta que diga que no"
    : "No lo ha indicado: no recibe promociones por WhatsApp";
}

/**
 * The client's choices about promotions, in their file. The salon can write
 * down a WhatsApp opt-in the client gave in person (the record says the
 * salon wrote it); the email choice is only the client's to make.
 */
export function ClientMarketingCard({ clientId }: { clientId: string }) {
  const { toast } = useToast();
  const [data, setData] = useState<{ email: MarketingConsentState; whatsapp: MarketingConsentState } | null>(null);
  const [hidden, setHidden] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiClient.getClientMarketingConsent(clientId));
    } catch {
      setHidden(true);
    }
  }, [clientId]);

  useEffect(() => {
    load();
  }, [load]);

  async function record(accepts: boolean) {
    setBusy(true);
    try {
      const whatsapp = await apiClient.setClientWhatsAppMarketingConsent(clientId, accepts, accepts && confirmed);
      setData((d) => (d ? { ...d, whatsapp } : d));
      setConfirming(false);
      setConfirmed(false);
      toast({ title: accepts ? "Anotado: acepta promociones por WhatsApp" : "Anotado: no quiere promociones por WhatsApp" });
    } catch (err: any) {
      toast({ title: "No se pudo guardar", description: err?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  if (hidden) return null;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
        <Megaphone className="h-4 w-4 text-purple-600" /> Promociones
      </h2>
      {!data ? (
        <Loader2 className="mt-3 h-4 w-4 animate-spin text-gray-400" />
      ) : (
        <dl className="mt-3 space-y-3 text-sm">
          <div>
            <dt className="font-medium text-gray-700">Por email</dt>
            <dd className="text-gray-600">{describe(data.email, "email")}</dd>
          </div>
          <div>
            <dt className="font-medium text-gray-700">Por WhatsApp</dt>
            <dd className="text-gray-600">{describe(data.whatsapp, "whatsapp")}</dd>
            {data.whatsapp.status !== "granted" && !confirming && (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="mt-2 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Anotar que acepta
              </button>
            )}
            {data.whatsapp.status === "granted" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => record(false)}
                className="mt-2 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Anotar que ya no quiere
              </button>
            )}
            {confirming && (
              <div className="mt-2 space-y-2 rounded-lg bg-gray-50 p-3">
                <label className="flex items-start gap-2 text-xs text-gray-700">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    El cliente me ha dicho que quiere recibir promociones del salón por WhatsApp y sabe que
                    puede darse de baja respondiendo BAJA. Quedará anotado con mi nombre.
                  </span>
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={!confirmed || busy}
                    onClick={() => record(true)}
                    className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    Guardar
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(false);
                      setConfirmed(false);
                    }}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-white"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </dl>
      )}
    </section>
  );
}
