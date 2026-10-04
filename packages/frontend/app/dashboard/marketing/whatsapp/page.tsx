"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, MessageCircle, Plus, Send, Trash2, X, Pencil, Ban, Users } from "lucide-react";
import apiClient, {
  WhatsAppAudiencePreview,
  WhatsAppCampaign,
  WhatsAppConnection,
} from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import {
  CAMPAIGN_FOOTER,
  MAX_BODY_LENGTH,
  Tone,
  bodyProblem,
  campaignActions,
  campaignLabel,
  previewBody,
} from "@/lib/whatsapp-campaign";

const TONES: Record<Tone, string> = {
  gray: "bg-gray-100 text-gray-700",
  amber: "bg-amber-100 text-amber-800",
  blue: "bg-blue-100 text-blue-800",
  green: "bg-green-100 text-green-800",
  red: "bg-red-100 text-red-700",
};

const SEGMENTS = [
  { value: "", label: "Todos los clientes que lo han aceptado" },
  { value: "30", label: "Sin venir desde hace más de 30 días" },
  { value: "60", label: "Sin venir desde hace más de 60 días" },
  { value: "90", label: "Sin venir desde hace más de 90 días" },
  { value: "180", label: "Sin venir desde hace más de 6 meses" },
];

interface FormState {
  id: string | null;
  name: string;
  body: string;
  segment: string;
  scheduledAt: string;
}

const EMPTY_FORM: FormState = { id: null, name: "", body: "", segment: "", scheduledAt: "" };

function formatDate(iso: string) {
  return new Date(iso).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" });
}

/** <input type="datetime-local"> value for an ISO date, in the browser's zone. */
function toLocalInput(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * WhatsApp promotions from the salon's own number. The salon writes the
 * message; Meta reviews it as a template (hours, sometimes a day); then it
 * goes, between 9:00 and 21:00, only to clients who agreed to receive
 * promotions by WhatsApp.
 */
export default function WhatsAppCampaignsPage() {
  const { toast } = useToast();
  const [connection, setConnection] = useState<WhatsAppConnection | null | undefined>(undefined);
  const [campaigns, setCampaigns] = useState<WhatsAppCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [audience, setAudience] = useState<WhatsAppAudiencePreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [conn, list] = await Promise.all([
        apiClient.getWhatsAppConnection().catch(() => null),
        apiClient.listWhatsAppCampaigns(),
      ]);
      setConnection(conn);
      setCampaigns(list);
    } catch (err: any) {
      toast({ title: "No se pudieron cargar las campañas", description: err?.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // While something waits for Meta or is being sent, refresh now and then.
  useEffect(() => {
    const active = campaigns.some((c) => c.status === "scheduled" || c.status === "sending");
    if (!active) return;
    const timer = setInterval(() => {
      apiClient.listWhatsAppCampaigns().then(setCampaigns).catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [campaigns]);

  // Audience of the form being edited.
  const segment = form?.segment ?? null;
  useEffect(() => {
    if (segment === null) return;
    setAudience(null);
    const handle = setTimeout(() => {
      apiClient
        .getWhatsAppCampaignAudience(segment ? Number(segment) : null)
        .then(setAudience)
        .catch(() => setAudience(null));
    }, 250);
    return () => clearTimeout(handle);
  }, [segment]);

  const problem = form ? bodyProblem(form.body) : null;
  const connected = !!connection?.isActive;

  function openNew() {
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(c: WhatsAppCampaign) {
    setForm({
      id: c.id,
      name: c.name,
      body: c.body,
      segment: c.segmentFilter?.inactiveDays ? String(c.segmentFilter.inactiveDays) : "",
      scheduledAt: toLocalInput(c.scheduledAt),
    });
  }

  async function save(andSubmit: boolean) {
    if (!form) return;
    if (!form.name.trim() || !form.body.trim()) {
      toast({ title: "Pon un nombre y escribe el mensaje", variant: "destructive" });
      return;
    }
    if (problem) {
      toast({ title: problem, variant: "destructive" });
      return;
    }
    setBusy("save");
    try {
      const input = {
        name: form.name.trim(),
        body: form.body.trim(),
        inactiveDays: form.segment ? Number(form.segment) : null,
        scheduledAt: form.scheduledAt ? new Date(form.scheduledAt).toISOString() : null,
      };
      const saved = form.id
        ? await apiClient.updateWhatsAppCampaign(form.id, input)
        : await apiClient.createWhatsAppCampaign(input);
      if (andSubmit) {
        await apiClient.submitWhatsAppCampaign(saved.id);
        toast({
          title: "Enviada a revisión de Meta",
          description: "Se enviará cuando Meta la apruebe, normalmente en unas horas.",
        });
      } else {
        toast({ title: "Borrador guardado" });
      }
      setForm(null);
      await load();
    } catch (err: any) {
      toast({ title: "No se pudo guardar", description: err?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function act(c: WhatsAppCampaign, action: "submit" | "cancel" | "remove") {
    const confirmText = {
      submit: `¿Enviar «${c.name}» a revisión de Meta? Cuando la apruebe se enviará a los clientes que lo hayan aceptado.`,
      cancel: `¿Cancelar «${c.name}»? Lo que ya se haya enviado no se puede deshacer.`,
      remove: `¿Eliminar «${c.name}»?`,
    }[action];
    if (!confirm(confirmText)) return;
    setBusy(c.id);
    try {
      if (action === "submit") await apiClient.submitWhatsAppCampaign(c.id);
      if (action === "cancel") await apiClient.cancelWhatsAppCampaign(c.id);
      if (action === "remove") await apiClient.deleteWhatsAppCampaign(c.id);
      await load();
    } catch (err: any) {
      toast({ title: "No se pudo hacer", description: err?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  const preview = useMemo(() => (form ? previewBody(form.body) : ""), [form]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Campañas de WhatsApp</h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-500">
            Promociones desde el WhatsApp de tu salón. Meta revisa cada mensaje antes de enviarlo
            (normalmente unas horas), y solo lo reciben los clientes que han aceptado promociones por
            WhatsApp, entre las 9:00 y las 21:00.
          </p>
        </div>
        <button
          type="button"
          onClick={openNew}
          disabled={!connected}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" /> Nueva campaña
        </button>
      </div>

      {connection === null && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Para enviar campañas, conecta antes el WhatsApp de tu salón en{" "}
          <Link href="/dashboard/settings/whatsapp" className="font-medium underline">
            Ajustes → WhatsApp
          </Link>
          .
        </div>
      )}

      <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
        <p>
          <strong className="text-gray-900">Quién las recibe.</strong> WhatsApp solo permite promociones a
          quien ha aceptado recibirlas. Tus clientes pueden aceptarlas desde su cuenta en tu web, o puedes
          anotarlo en su ficha cuando te lo digan en el salón. Si responden BAJA, dejan de recibirlas.
        </p>
        <p className="mt-2">
          <strong className="text-gray-900">Coste.</strong> Meta cobra los mensajes de promoción
          directamente a la cuenta de WhatsApp Business de tu salón, según su tarifa por país.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : campaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">
          <MessageCircle className="mx-auto mb-2 h-8 w-8 text-gray-300" />
          Aún no has creado ninguna campaña.
        </div>
      ) : (
        <ul className="space-y-3">
          {campaigns.map((c) => {
            const label = campaignLabel(c, formatDate);
            const actions = campaignActions(c);
            return (
              <li key={c.id} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold text-gray-900">{c.name}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONES[label.tone]}`}>
                        {label.text}
                      </span>
                    </div>
                    {label.detail && <p className="mt-1 text-sm text-gray-600">{label.detail}</p>}
                    <p className="mt-2 line-clamp-2 whitespace-pre-line text-sm text-gray-500">{c.body}</p>
                    {(c.status === "sending" || c.status === "completed") && c.totalRecipients > 0 && (
                      <p className="mt-2 text-xs text-gray-500">
                        {c.totalRecipients} destinatarios
                        {c.status === "completed" &&
                          ` · ${c.sent} enviados · ${c.delivered} entregados · ${c.read} leídos · ${c.failed} fallidos · ${c.optedOut} bajas`}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {actions.edit && (
                      <button
                        type="button"
                        onClick={() => openEdit(c)}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        <Pencil className="h-3 w-3" /> Editar
                      </button>
                    )}
                    {actions.submit && (
                      <button
                        type="button"
                        disabled={!connected || busy === c.id}
                        onClick={() => act(c, "submit")}
                        className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        <Send className="h-3 w-3" /> Enviar a revisión
                      </button>
                    )}
                    {actions.cancel && (
                      <button
                        type="button"
                        disabled={busy === c.id}
                        onClick={() => act(c, "cancel")}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        <Ban className="h-3 w-3" /> Cancelar
                      </button>
                    )}
                    {actions.remove && (
                      <button
                        type="button"
                        disabled={busy === c.id}
                        onClick={() => act(c, "remove")}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                        aria-label={`Eliminar ${c.name}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {form && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="my-8 w-full max-w-3xl rounded-xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-lg font-semibold">{form.id ? "Editar campaña" : "Nueva campaña de WhatsApp"}</h2>
              <button type="button" onClick={() => setForm(null)} aria-label="Cerrar">
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>
            <div className="grid gap-6 p-6 md:grid-cols-2">
              <div className="space-y-4">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-gray-700">Nombre (solo lo ves tú)</span>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    maxLength={120}
                    placeholder="Mechas de otoño"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 flex items-center justify-between text-sm font-medium text-gray-700">
                    Mensaje
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, body: `${form.body}{{nombre}}` })}
                      className="text-xs font-normal text-green-700 hover:underline"
                    >
                      Insertar {"{{nombre}}"}
                    </button>
                  </span>
                  <textarea
                    value={form.body}
                    onChange={(e) => setForm({ ...form, body: e.target.value })}
                    rows={7}
                    placeholder={"Hola {{nombre}}, este mes tienes un 20 % en mechas. Reserva en nuestra web."}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <span className={`mt-1 block text-xs ${problem ? "text-red-600" : "text-gray-500"}`}>
                    {problem ?? `${form.body.trim().length} / ${MAX_BODY_LENGTH} caracteres. {{nombre}} se cambia por el nombre de cada cliente.`}
                  </span>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-gray-700">A quién</span>
                  <select
                    value={form.segment}
                    onChange={(e) => setForm({ ...form, segment: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  >
                    {SEGMENTS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 flex items-start gap-1 text-xs text-gray-500">
                    <Users className="mt-0.5 h-3 w-3 shrink-0" />
                    {audience ? (
                      <span>
                        Ahora mismo la recibirían <strong className="text-gray-800">{audience.eligible}</strong>{" "}
                        clientes. {audience.withoutConsent} más no han aceptado promociones por WhatsApp y{" "}
                        {audience.withoutPhone} no tienen teléfono.
                      </span>
                    ) : (
                      <span>Calculando…</span>
                    )}
                  </span>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-gray-700">Cuándo (opcional)</span>
                  <input
                    type="datetime-local"
                    value={form.scheduledAt}
                    onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                  <span className="mt-1 block text-xs text-gray-500">
                    Vacío: en cuanto Meta la apruebe. Siempre entre las 9:00 y las 21:00.
                  </span>
                </label>
              </div>

              <div>
                <span className="mb-1 block text-sm font-medium text-gray-700">Así lo verá el cliente</span>
                <div className="rounded-xl bg-[#e5ddd5] p-4">
                  <div className="max-w-[90%] rounded-lg rounded-tl-none bg-white px-3 py-2 text-sm shadow-sm">
                    <p className="whitespace-pre-line break-words text-gray-900">
                      {preview || <span className="text-gray-400">Tu mensaje…</span>}
                    </p>
                    <p className="mt-2 text-xs text-gray-500">{CAMPAIGN_FOOTER}</p>
                  </div>
                </div>
                <p className="mt-3 text-xs text-gray-500">
                  Meta revisa el texto antes de enviarlo. Evita mayúsculas excesivas, enlaces acortados y
                  promesas engañosas; si lo rechaza, verás el motivo y podrás corregirlo.
                </p>
              </div>
            </div>
            <div className="flex flex-col-reverse gap-2 border-t border-gray-200 px-6 py-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setForm(null)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
              >
                Cerrar
              </button>
              <button
                type="button"
                disabled={busy === "save"}
                onClick={() => save(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
              >
                Guardar borrador
              </button>
              <button
                type="button"
                disabled={busy === "save" || !connected || !!problem}
                onClick={() => save(true)}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
              >
                {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Enviar a revisión de Meta
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
