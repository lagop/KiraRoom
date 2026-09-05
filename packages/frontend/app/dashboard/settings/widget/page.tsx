"use client";

import { useEffect, useState } from "react";
import {
  Copy,
  QrCode,
  Trash2,
  RefreshCw,
  Code as CodeIcon,
  ExternalLink,
} from "lucide-react";
import apiClient, {
  WidgetInstance,
  Service,
  Professional,
} from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

function buildEmbedSnippet(token: string, frontendUrl?: string) {
  const base = (frontendUrl ||
    (typeof window !== "undefined" ? window.location.origin : "https://app.kiraroom.app")
  ).replace(/\/$/, "");
  const url = `${base}/embed/${token}`;
  return `<iframe src="${url}" width="100%" height="640" style="border:0;border-radius:12px" loading="lazy"></iframe>`;
}

export default function WidgetSettingsPage() {
  const { toast } = useToast();
  const [instances, setInstances] = useState<WidgetInstance[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [allowedOriginsText, setAllowedOriginsText] = useState("");
  const [loading, setLoading] = useState(true);
  const [tenantSlug, setTenantSlug] = useState<string>("");

  async function load() {
    setLoading(true);
    try {
      const [list, t] = await Promise.all([
        apiClient.listWidgetInstances(),
        apiClient.getTenant().catch(() => null),
      ]);
      setInstances(list);
      if (t?.slug) setTenantSlug(t.slug);
      try {
        const svcs = await apiClient.getServices();
        setServices(svcs);
      } catch {
        setServices([]);
      }
      try {
        const profs = await apiClient.getProfessionals();
        setProfessionals(profs);
      } catch {
        setProfessionals([]);
      }
    } catch (err) {
      console.error(err);
      toast({ title: "Error cargando widgets", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate() {
    if (!name.trim()) {
      toast({ title: "El nombre es obligatorio", variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const allowedOrigins = allowedOriginsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      await apiClient.createWidgetInstance({
        name: name.trim(),
        allowedOrigins,
      });
      setName("");
      setAllowedOriginsText("");
      toast({ title: "Widget creado" });
      await load();
    } catch (err: any) {
      toast({
        title: "No se pudo crear",
        description: err?.message,
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm("¿Revocar este widget? Las reservas pendientes no se verán afectadas pero el iframe dejará de funcionar.")) return;
    try {
      await apiClient.revokeWidgetInstance(id);
      toast({ title: "Widget revocado" });
      await load();
    } catch (err: any) {
      toast({ title: err?.message ?? "Error", variant: "destructive" });
    }
  }

  function copy(text: string, label = "Copiado") {
    navigator.clipboard.writeText(text).then(
      () => toast({ title: label }),
      () => toast({ title: "No se pudo copiar", variant: "destructive" }),
    );
  }

  const frontendUrl =
    typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Widget de reservas</h1>
        <p className="text-gray-500 mt-1">
          Pega este iframe en tu web, Instagram bio o landing para que los clientes
          reserven directamente.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Crear nuevo widget</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Nombre interno
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Landing principal"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Orígenes permitidos (uno por línea, vacío = todos)
            </label>
            <textarea
              value={allowedOriginsText}
              onChange={(e) => setAllowedOriginsText(e.target.value)}
              rows={3}
              placeholder={"https://misalon.com\nhttps://misalon.es"}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            />
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <button
            onClick={handleCreate}
            disabled={creating}
            className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition disabled:opacity-50"
          >
            {creating ? "Creando…" : "Crear widget"}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-gray-900">Widgets activos</h2>
          <button
            onClick={load}
            className="text-gray-500 hover:text-gray-700"
            title="Recargar"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
        {loading ? (
          <div className="text-gray-500 text-sm">Cargando…</div>
        ) : instances.length === 0 ? (
          <div className="text-gray-500 text-sm">No hay widgets todavía.</div>
        ) : (
          <div className="space-y-4">
            {instances.map((w) => {
              const snippet = w.token ? buildEmbedSnippet(w.token, frontendUrl) : "";
              const qrUrl = tenantSlug
                ? `${apiClient["request"] ? "" : ""}${API}/qr/salon/${tenantSlug}`
                : "";
              return (
                <div
                  key={w.id}
                  className="border border-gray-200 rounded-lg p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-gray-900">{w.name}</div>
                      <div className="text-xs text-gray-500">
                        {w.bookCount ?? 0} reservas ·{" "}
                        {w.lastUsedAt
                          ? `última ${new Date(w.lastUsedAt).toLocaleString()}`
                          : "sin uso aún"}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRevoke(w.id)}
                      className="text-red-600 hover:bg-red-50 p-2 rounded-lg"
                      title="Revocar"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {w.token && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">
                          <CodeIcon className="inline w-3 h-3 mr-1" /> Snippet HTML
                        </label>
                        <div className="flex items-start gap-2">
                          <pre className="flex-1 bg-gray-50 border border-gray-200 rounded p-2 text-xs overflow-x-auto">
                            {snippet}
                          </pre>
                          <button
                            onClick={() => copy(snippet, "HTML copiado")}
                            className="bg-gray-100 hover:bg-gray-200 p-2 rounded"
                            title="Copiar"
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">
                          URL directa
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            readOnly
                            value={`${frontendUrl}/embed/${w.token}`}
                            className="flex-1 bg-gray-50 border border-gray-200 rounded px-2 py-1 text-xs"
                          />
                          <button
                            onClick={() =>
                              copy(
                                `${frontendUrl}/embed/${w.token}`,
                                "URL copiada",
                              )
                            }
                            className="bg-gray-100 hover:bg-gray-200 p-2 rounded"
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                          <a
                            href={`${frontendUrl}/embed/${w.token}`}
                            target="_blank"
                            rel="noreferrer"
                            className="bg-gray-100 hover:bg-gray-200 p-2 rounded"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        </div>
                      </div>
                      {tenantSlug && (
                        <div className="flex items-center gap-3">
                          <QrCode className="w-4 h-4 text-gray-500" />
                          <a
                            href={`${API.replace(/\/api\/v1$/, "")}/api/v1/qr/salon/${tenantSlug}?format=png`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-purple-600 hover:underline text-sm"
                          >
                            Descargar QR del salón (PNG)
                          </a>
                          <span className="text-gray-300">·</span>
                          <a
                            href={`${API.replace(/\/api\/v1$/, "")}/api/v1/qr/salon/${tenantSlug}?format=svg`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-purple-600 hover:underline text-sm"
                          >
                            SVG
                          </a>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";