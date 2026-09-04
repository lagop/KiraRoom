"use client";

import { useEffect, useState } from "react";
import { Send, Plus, Trash2, RefreshCw } from "lucide-react";
import apiClient, { Client } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

interface Template {
  name: string;
  status: string;
  language?: string;
}

export default function WhatsAppCampaignsPage() {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [varsText, setVarsText] = useState("");
  const [audience, setAudience] = useState<string[]>([]);
  const [scheduledAt, setScheduledAt] = useState("");
  const [daysInactive, setDaysInactive] = useState<number | "all">(60);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [t, c] = await Promise.all([
        apiClient.listWhatsAppTemplates().catch(() => []),
        apiClient.getClients().catch(() => []),
      ]);
      setTemplates(t);
      setClients(c);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function buildSegment(): string[] {
    if (daysInactive === "all") return clients.map((c) => c.id);
    const cutoff = Date.now() - daysInactive * 24 * 60 * 60 * 1000;
    return clients
      .filter((c) => {
        const last = c.lastVisit ? new Date(c.lastVisit).getTime() : 0;
        return !last || last < cutoff;
      })
      .map((c) => c.id);
  }

  function refreshAudience() {
    setAudience(buildSegment());
    toast({ title: `Audiencia: ${audience.length} clientes` });
  }

  async function createCampaign() {
    if (!templateId) {
      toast({ title: "Selecciona una plantilla", variant: "destructive" });
      return;
    }
    if (audience.length === 0) {
      toast({ title: "Audiencia vacía", variant: "destructive" });
      return;
    }
    try {
      const templateVars: Record<string, string> = {};
      varsText
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .forEach((line) => {
          const [k, ...rest] = line.split("=");
          templateVars[k.trim()] = rest.join("=").trim();
        });
      const segFilter =
        daysInactive === "all" ? { all: true } : { inactiveDays: daysInactive };
      const camp = await apiClient.createWhatsAppCampaign({
        name: name || `Campaña ${new Date().toLocaleString()}`,
        templateId,
        templateVars,
        segmentFilter: segFilter,
        audience,
        scheduledAt: scheduledAt || undefined,
      });
      toast({ title: "Campaña creada" });
      const action = scheduledAt ? "scheduled" : "send";
      if (action === "send" && confirm("¿Enviar ahora?")) {
        const r = await apiClient.sendWhatsAppCampaign(camp.id);
        toast({ title: `${r.enqueued} mensajes encolados` });
      }
      setName("");
      setTemplateId("");
      setVarsText("");
      setAudience([]);
    } catch (err: any) {
      toast({
        title: "Error creando campaña",
        description: err?.message,
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Campañas WhatsApp</h1>
        <p className="text-gray-500 mt-1">
          Plantillas Meta aprobadas · rate-limit por tier · ventana 9-21h
          local · opt-out STOP automático.
        </p>
      </div>

      {loading ? (
        <div className="text-gray-500">Cargando…</div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Nombre interno">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Reactivación Q3"
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </Field>
            <Field label="Plantilla (APPROVED)">
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              >
                <option value="">— Selecciona —</option>
                {templates.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name} ({t.language || "es"})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Segmento">
              <select
                value={daysInactive}
                onChange={(e) =>
                  setDaysInactive(
                    e.target.value === "all" ? "all" : Number(e.target.value),
                  )
                }
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              >
                <option value="all">Todos los clientes</option>
                <option value="30">Inactivos &gt; 30 días</option>
                <option value="60">Inactivos &gt; 60 días</option>
                <option value="90">Inactivos &gt; 90 días</option>
                <option value="180">Inactivos &gt; 180 días</option>
              </select>
            </Field>
            <Field label="Programado para (opcional)">
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </Field>
            <div className="md:col-span-2">
              <Field label="Variables de plantilla (key=value, una por línea)">
                <textarea
                  value={varsText}
                  onChange={(e) => setVarsText(e.target.value)}
                  rows={3}
                  placeholder={`1 = "María"\n2 = "10% de descuento"`}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm"
                />
              </Field>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={refreshAudience}
              className="text-purple-600 hover:underline text-sm inline-flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" /> Recalcular audiencia
            </button>
            <span className="text-sm text-gray-500">
              {audience.length} cliente{audience.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="flex justify-end">
            <button
              onClick={createCampaign}
              className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 inline-flex items-center gap-2"
            >
              <Send className="w-4 h-4" /> Crear campaña
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
    </div>
  );
}