"use client";

import { useEffect, useState } from "react";
import {
  Copy,
  QrCode,
  Trash2,
  RefreshCw,
  Code as CodeIcon,
  ExternalLink,
  Pencil,
} from "lucide-react";
import apiClient, {
  WidgetInstance,
  Service,
  Professional,
} from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { draftFrom, parseOrigins, toggleId, widgetUpdateFrom, type WidgetDraft } from "@/lib/widget-edit";
// The iframe, named for the salon, and the script that sizes it to the widget.
import { buildEmbedSnippet } from "@/lib/embed-snippet";

export default function WidgetSettingsPage() {
  const { toast } = useToast();
  const [instances, setInstances] = useState<WidgetInstance[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [allowedOriginsText, setAllowedOriginsText] = useState("");
  const [loading, setLoading] = useState(true);
  // The widget being edited (allowed sites, services, professionals).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WidgetDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  // The widget about to be revoked, confirmed in the panel's dialog.
  const [pendingRevoke, setPendingRevoke] = useState<WidgetInstance | null>(null);
  const [revoking, setRevoking] = useState(false);
  // For the iframe title in the snippet ("Reservar cita en <salón>").
  const [salonName, setSalonName] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setInstances(await apiClient.listWidgetInstances());
      // For the editor's pickers.
      try {
        const svcs = await apiClient.getServices();
        setServices(svcs);
      } catch {
        setServices([]);
      }
      try {
        setSalonName((await apiClient.getTenant()).name ?? null);
      } catch {
        setSalonName(null);
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
      const allowedOrigins = parseOrigins(allowedOriginsText);
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

  async function performRevoke() {
    if (!pendingRevoke) return;
    setRevoking(true);
    try {
      await apiClient.revokeWidgetInstance(pendingRevoke.id);
      toast({ title: "Widget revocado" });
      await load();
    } catch (err: any) {
      toast({ title: err?.message ?? "Error", variant: "destructive" });
    } finally {
      setRevoking(false);
      setPendingRevoke(null);
    }
  }

  function startEdit(w: WidgetInstance) {
    setEditingId(w.id);
    setDraft(draftFrom(w));
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }

  async function saveEdit() {
    if (!editingId || !draft) return;
    setSavingEdit(true);
    try {
      await apiClient.updateWidgetInstance(editingId, widgetUpdateFrom(draft, { services, professionals }));
      toast({ title: "Widget actualizado", description: "El código de tu web no cambia." });
      cancelEdit();
      await load();
    } catch (err: any) {
      toast({ title: "No se pudo guardar", description: err?.message, variant: "destructive" });
    } finally {
      setSavingEdit(false);
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
          Pega este código en tu web para que tus clientas reserven sin salir de ella. Para Instagram o
          WhatsApp usa el enlace de tu página de reservas, en{" "}
          <a href="/dashboard/compartir" className="text-purple-600 hover:underline">
            Comparte tu página
          </a>
          .
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
              Webs donde se puede mostrar (una por línea; vacío = cualquiera)
            </label>
            <textarea
              value={allowedOriginsText}
              onChange={(e) => setAllowedOriginsText(e.target.value)}
              rows={3}
              placeholder={"https://misalon.com\nhttps://misalon.es"}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              Solo direcciones https, sin ruta (https://misalon.com). Con la lista vacía, el widget se puede
              insertar en cualquier web.
            </p>
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
              const snippet = w.token
                ? buildEmbedSnippet(w.token, frontendUrl || "https://app.kiraroom.net", salonName)
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
                          ? `última ${new Date(w.lastUsedAt).toLocaleString("es-ES")}`
                          : "sin uso aún"}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => (editingId === w.id ? cancelEdit() : startEdit(w))}
                        className="text-gray-600 hover:bg-gray-50 p-2 rounded-lg"
                        title="Editar"
                        aria-label={`Editar el widget ${w.name}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setPendingRevoke(w)}
                        className="text-red-600 hover:bg-red-50 p-2 rounded-lg"
                        title="Revocar"
                        aria-label={`Revocar el widget ${w.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {editingId === w.id && draft && (
                    <WidgetEditor
                      draft={draft}
                      onChange={setDraft}
                      services={services}
                      professionals={professionals}
                      saving={savingEdit}
                      onSave={saveEdit}
                      onCancel={cancelEdit}
                    />
                  )}

                  {editingId !== w.id && (w.allowedOrigins.length > 0 || w.services.length > 0 || w.professionals.length > 0) && (
                    <p className="text-xs text-gray-500">
                      {w.allowedOrigins.length > 0 ? `Solo en: ${w.allowedOrigins.join(", ")}` : "En cualquier web"}
                      {w.services.length > 0 ? ` · ${w.services.length} servicios` : ""}
                      {w.professionals.length > 0 ? ` · ${w.professionals.length} profesionales` : ""}
                    </p>
                  )}

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
                      <div className="flex items-center gap-3">
                        <QrCode className="w-4 h-4 text-gray-500" />
                        <a href="/dashboard/compartir" className="text-purple-600 hover:underline text-sm">
                          QR, carteles, tarjetas e imagen para redes → Comparte tu página
                        </a>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!pendingRevoke}
        title={`¿Revocar el widget «${pendingRevoke?.name ?? ""}»?`}
        description="Las reservas ya hechas no se ven afectadas, pero el iframe dejará de funcionar en tu web."
        confirmLabel="Revocar widget"
        destructive
        loading={revoking}
        onCancel={() => setPendingRevoke(null)}
        onConfirm={performRevoke}
      />
    </div>
  );
}

/** Allowed sites, services and professionals of an existing widget; its code does not change. */
function WidgetEditor({
  draft,
  onChange,
  services,
  professionals,
  saving,
  onSave,
  onCancel,
}: {
  draft: WidgetDraft;
  onChange: (d: WidgetDraft) => void;
  services: Service[];
  professionals: Professional[];
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const bookable = services.filter((s) => s.isActive !== false);
  const team = professionals.filter((p) => p.isActive !== false);
  return (
    <div className="rounded-lg border border-purple-100 bg-purple-50/40 p-4 space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Webs donde se puede mostrar (una por línea; vacío = cualquiera)
        </label>
        <textarea
          value={draft.allowedOriginsText}
          onChange={(e) => onChange({ ...draft, allowedOriginsText: e.target.value })}
          rows={3}
          placeholder={"https://misalon.com\nhttps://misalon.es"}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <PickList
          legend="Servicios (ninguno marcado = todos los reservables)"
          items={bookable.map((s) => ({ id: s.id, label: s.name }))}
          selected={draft.services}
          onToggle={(id) => onChange({ ...draft, services: toggleId(draft.services, id) })}
          empty="No hay servicios."
        />
        <PickList
          legend="Profesionales (ninguno marcado = todo el equipo)"
          items={team.map((p) => ({ id: p.id, label: `${p.firstName} ${p.lastName ?? ""}`.trim() }))}
          selected={draft.professionals}
          onToggle={(id) => onChange({ ...draft, professionals: toggleId(draft.professionals, id) })}
          empty="No hay profesionales."
        />
      </div>
      <p className="text-xs text-gray-500">El código que pegaste en tu web sigue siendo el mismo.</p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancelar
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="bg-purple-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-purple-700 disabled:opacity-50"
        >
          {saving ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
    </div>
  );
}

function PickList({
  legend,
  items,
  selected,
  onToggle,
  empty,
}: {
  legend: string;
  items: Array<{ id: string; label: string }>;
  selected: string[];
  onToggle: (id: string) => void;
  empty: string;
}) {
  return (
    <fieldset>
      <legend className="block text-sm font-medium text-gray-700 mb-1">{legend}</legend>
      {items.length === 0 ? (
        <p className="text-xs text-gray-500">{empty}</p>
      ) : (
        <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 space-y-1">
          {items.map((i) => (
            <label key={i.id} className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={selected.includes(i.id)}
                onChange={() => onToggle(i.id)}
                className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
              />
              <span className="truncate">{i.label}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}