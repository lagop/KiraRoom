"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Save, AlertTriangle } from "lucide-react";
import apiClient, { ConsentForm, ConsentFormField, ConsentFormInput } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

function blankField(type: ConsentFormField["type"]): ConsentFormField {
  return {
    id: `f_${Math.random().toString(36).slice(2, 8)}`,
    type,
    label: "",
    required: true,
  };
}

export default function ConsentFormsPage() {
  const { toast } = useToast();
  const [forms, setForms] = useState<ConsentForm[]>([]);
  const [editing, setEditing] = useState<ConsentFormInput | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setForms(await apiClient.listConsentForms());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function startNew() {
    setEditing({
      name: "",
      description: "",
      fields: [
        { id: `f_${Date.now()}`, type: "info", label: "Información legal", required: false },
        {
          id: `f_${Date.now() + 1}`,
          type: "boolean",
          label: "Acepto los términos",
          required: true,
        },
      ],
      serviceIds: [],
    });
    setEditId(null);
  }

  function startEdit(f: ConsentForm) {
    setEditing({
      name: f.name,
      description: f.description ?? "",
      fields: f.fields,
      serviceIds: f.serviceIds,
    });
    setEditId(f.id);
  }

  async function save() {
    if (!editing?.name.trim()) {
      toast({ title: "Nombre obligatorio", variant: "destructive" });
      return;
    }
    if (editing.fields.length === 0) {
      toast({ title: "Añade al menos un campo", variant: "destructive" });
      return;
    }
    try {
      if (editId) {
        const updated = await apiClient.updateConsentForm(editId, editing);
        toast({
          title: `Nueva versión creada (v${updated.version})`,
          description: "Las firmas existentes mantienen la versión anterior.",
        });
      } else {
        await apiClient.createConsentForm(editing);
        toast({ title: "Formulario creado" });
      }
      setEditing(null);
      setEditId(null);
      await load();
    } catch (err: any) {
      toast({
        title: "No se pudo guardar",
        description: err?.message,
        variant: "destructive",
      });
    }
  }

  async function remove(id: string) {
    if (!confirm("¿Eliminar este formulario? Las firmas existentes se preservan (append-only) pero el form no podrá editarse.")) return;
    try {
      await apiClient.deleteConsentForm(id);
      toast({ title: "Formulario eliminado" });
      await load();
    } catch (err: any) {
      toast({ title: err?.message ?? "Error", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Formularios de consentimiento</h1>
          <p className="text-gray-500 mt-1">
            Cumplimiento RGPD para servicios regulados. Cada edición crea una nueva
            versión inmutable; las firmas previas conservan su snapshot.
          </p>
        </div>
        <button
          onClick={startNew}
          className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 inline-flex items-center gap-2"
        >
          <Plus className="w-4 h-4" /> Nuevo formulario
        </button>
      </div>

      {loading ? (
        <div className="text-gray-500">Cargando…</div>
      ) : editing ? (
        <Editor
          value={editing}
          onChange={setEditing}
          isNew={!editId}
          onCancel={() => {
            setEditing(null);
            setEditId(null);
          }}
          onSave={save}
        />
      ) : forms.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-6 text-gray-500">
          No tienes formularios todavía.
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl divide-y">
          {forms.map((f) => (
            <div
              key={f.id}
              className="p-4 flex items-center justify-between"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{f.name}</span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      f.isActive
                        ? "bg-green-100 text-green-700"
                        : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    v{f.version} {f.isActive ? "activa" : "histórica"}
                  </span>
                  {f.serviceIds.length === 0 && (
                    <span className="text-xs px-2 py-0.5 rounded bg-purple-100 text-purple-700">
                      global
                    </span>
                  )}
                </div>
                {f.description && (
                  <div className="text-sm text-gray-500 mt-1">{f.description}</div>
                )}
                <div className="text-xs text-gray-400 mt-1">
                  {f.fields.length} campo{f.fields.length === 1 ? "" : "s"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => startEdit(f)}
                  className="text-purple-600 hover:underline text-sm"
                >
                  Editar
                </button>
                <button
                  onClick={() => remove(f.id)}
                  className="text-red-600 hover:bg-red-50 p-2 rounded"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5" />
        <div>
          El rechazo de firma NO bloquea el servicio (decisión RGPD). Se registra
          en el log de consentimientos con su IP-hash y timestamp. La cita pasa a
          <code> confirmed</code> solo si todos los consentimientos requeridos
          están firmados.
        </div>
      </div>
    </div>
  );
}

function Editor({
  value,
  onChange,
  isNew,
  onCancel,
  onSave,
}: {
  value: ConsentFormInput;
  onChange: (v: ConsentFormInput) => void;
  isNew: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  function updateField(i: number, patch: Partial<ConsentFormField>) {
    const next = [...value.fields];
    next[i] = { ...next[i], ...patch };
    onChange({ ...value, fields: next });
  }

  function addField(type: ConsentFormField["type"]) {
    onChange({ ...value, fields: [...value.fields, blankField(type)] });
  }

  function removeField(i: number) {
    const next = value.fields.filter((_, idx) => idx !== i);
    onChange({ ...value, fields: next });
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
      <h2 className="font-semibold">{isNew ? "Nuevo formulario" : "Editar formulario"}</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Nombre</label>
          <input
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="Reacciones alérgicas — Depilación láser"
            className="w-full border border-gray-300 rounded-lg px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Descripción
          </label>
          <input
            value={value.description ?? ""}
            onChange={(e) => onChange({ ...value, description: e.target.value })}
            className="w-full border border-gray-300 rounded-lg px-3 py-2"
          />
        </div>
      </div>

      <div className="space-y-3">
        {value.fields.map((f, i) => (
          <div key={f.id} className="border border-gray-200 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase text-gray-500">{f.type}</span>
              <button
                onClick={() => removeField(i)}
                className="text-red-600 hover:bg-red-50 p-1 rounded"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <input
              value={f.label}
              onChange={(e) => updateField(i, { label: e.target.value })}
              placeholder="Etiqueta visible para el cliente"
              className="w-full border border-gray-300 rounded px-3 py-1 text-sm"
            />
            {f.type === "select" && (
              <input
                value={(f.options ?? []).join(",")}
                onChange={(e) =>
                  updateField(i, {
                    options: e.target.value.split(",").map((s) => s.trim()),
                  })
                }
                placeholder="opción1, opción2, opción3"
                className="w-full border border-gray-300 rounded px-3 py-1 text-sm"
              />
            )}
            {f.type !== "info" && (
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={!!f.required}
                  onChange={(e) => updateField(i, { required: e.target.checked })}
                />
                Requerido
              </label>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => addField("boolean")}
          className="border border-gray-300 px-2 py-1 rounded text-sm"
        >
          + Checkbox
        </button>
        <button
          onClick={() => addField("text")}
          className="border border-gray-300 px-2 py-1 rounded text-sm"
        >
          + Texto
        </button>
        <button
          onClick={() => addField("select")}
          className="border border-gray-300 px-2 py-1 rounded text-sm"
        >
          + Selección
        </button>
        <button
          onClick={() => addField("date")}
          className="border border-gray-300 px-2 py-1 rounded text-sm"
        >
          + Fecha
        </button>
        <button
          onClick={() => addField("info")}
          className="border border-gray-300 px-2 py-1 rounded text-sm"
        >
          + Info
        </button>
      </div>

      <div className="flex justify-end gap-2 pt-3 border-t">
        <button
          onClick={onCancel}
          className="px-4 py-2 border border-gray-300 rounded-lg"
        >
          Cancelar
        </button>
        <button
          onClick={onSave}
          className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 inline-flex items-center gap-2"
        >
          <Save className="w-4 h-4" /> {isNew ? "Crear" : "Guardar (nueva versión)"}
        </button>
      </div>
    </div>
  );
}