"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, Upload, Check, AlertTriangle, FileText } from "lucide-react";
import apiClient, { ImportPreviewRow, ImportPreviewResult, ImportCommitResult } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

type Step = "download" | "upload" | "preview" | "done";
type Kind = "clients" | "services" | "appointments";

const KINDS: Array<{ kind: Kind; label: string; param: string }> = [
  { kind: "clients", label: "Clientes", param: "clientes" },
  { kind: "services", label: "Servicios", param: "servicios" },
  { kind: "appointments", label: "Citas", param: "citas" },
];

/** dd/mm/yyyy, `days` from today: the example appointments must be in the future. */
function inDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/**
 * Templates are built here, not fetched: the template URL used to open in a
 * new tab, which carries no session, so it answered 401.
 */
const TEMPLATES: Record<Kind, { filename: string; csv: string }> = {
  clients: {
    filename: "clientes-plantilla.csv",
    csv: [
      "Nombre,Apellidos,Teléfono,Email,Fecha de nacimiento,Notas",
      "María,García López,612 345 678,maria@example.com,12/05/1990,Prefiere las mañanas",
      "Pedro,Ruiz,698 765 432,,,",
    ].join("\n"),
  },
  services: {
    filename: "servicios-plantilla.csv",
    csv: [
      "Servicio,Duración,Precio,Categoría,Descripción",
      "Corte mujer,45 min,25,Peluquería,Lavado y corte",
      "Manicura semipermanente,1 h,22,Uñas,",
    ].join("\n"),
  },
  appointments: {
    filename: "citas-plantilla.csv",
    get csv() {
      return [
        "Fecha,Hora,Cliente,Teléfono,Email,Servicio,Profesional,Notas",
        `${inDays(7)},10:30,María García López,612 345 678,maria@example.com,Corte mujer,Carmen,`,
        `${inDays(9)},17:00,Pedro Ruiz,698 765 432,,Manicura semipermanente,Ana,Primera vez`,
      ].join("\n");
    },
  },
};

const COPY: Record<Kind, { title: string; intro: string; columns: string }> = {
  clients: {
    title: "Importar clientes",
    intro:
      "Sube la exportación de tu programa anterior (Booksy, Treatwell, Fresha…) o un Excel guardado como CSV. Reconocemos columnas como Nombre, Apellidos, Teléfono o Móvil, Email y Fecha de nacimiento. No se duplican las clientas que ya tienes: comparamos el email y el teléfono.",
    columns: "Nombre (o Cliente / Nombre completo), Apellidos, Teléfono o Móvil, Email, Fecha de nacimiento, Notas. Hace falta un teléfono o un email.",
  },
  services: {
    title: "Importar servicios",
    intro:
      "Sube tu lista de servicios como CSV. Si un servicio ya existe con el mismo nombre, actualizamos su duración y su precio.",
    columns: "Servicio, Duración (\"45 min\", \"1 h\", \"1:30\"), Precio (\"25\" o \"25,50 €\"), Categoría y Descripción (opcionales).",
  },
  appointments: {
    title: "Importar citas futuras",
    intro:
      "Trae la agenda pendiente de tu programa anterior para no tener que apuntarla otra vez. Solo se importan las citas que aún no han pasado. Cada una se une a tus servicios y profesionales por el nombre, y a la clienta por teléfono, email o nombre (si no existe, se crea). No se envía ninguna confirmación a las clientas.",
    columns:
      "Fecha (o Fecha y hora), Hora, Cliente (o Nombre y Apellidos), Teléfono, Email, Servicio, Profesional, y opcionales Duración, Precio, Notas y Estado (las canceladas se omiten). Importa antes tus servicios para que los nombres coincidan.",
  },
};

/** Excel on Windows saves CSV in Windows-1252; reading it as UTF-8 mangles every accent. */
async function readCsv(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(buffer) : utf8;
}

function ImportPageContent() {
  const { toast } = useToast();
  const params = useSearchParams();
  const [kind, setKind] = useState<Kind>(KINDS.find((k) => k.param === params?.get("tipo"))?.kind ?? "clients");
  // Appointments: the old program may still be sending its own reminders.
  const [sendReminders, setSendReminders] = useState(true);
  const [step, setStep] = useState<Step>("download");
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState<string>("");
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [commit, setCommit] = useState<ImportCommitResult | null>(null);
  const [busy, setBusy] = useState(false);

  function reset(next: Kind) {
    setKind(next);
    setStep("download");
    setFile(null);
    setCsv("");
    setPreview(null);
    setCommit(null);
  }

  function downloadTemplate() {
    const { filename, csv: text } = TEMPLATES[kind];
    // BOM so Excel opens the accents correctly.
    const url = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleFile(f: File) {
    setFile(f);
    setCsv(await readCsv(f));
  }

  async function runDryRun() {
    if (!csv) return;
    setBusy(true);
    try {
      const name = file?.name ?? "upload.csv";
      setPreview(
        kind === "clients"
          ? await apiClient.dryRunImportClients(csv, name)
          : kind === "services"
            ? await apiClient.dryRunImportServices(csv, name)
            : await apiClient.dryRunImportAppointments(csv, name, sendReminders),
      );
      setStep("preview");
    } catch (err: any) {
      toast({ title: "No se pudo leer el archivo", description: err?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function runCommit() {
    if (!csv) return;
    setBusy(true);
    try {
      const name = file?.name ?? "upload.csv";
      setCommit(
        kind === "clients"
          ? await apiClient.commitImportClients(csv, name)
          : kind === "services"
            ? await apiClient.commitImportServices(csv, name)
            : await apiClient.commitImportAppointments(csv, name, sendReminders),
      );
      setStep("done");
      toast({ title: "Importación completada" });
    } catch (err: any) {
      toast({ title: "Error al importar", description: err?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const importable = preview ? preview.stats.okCount + (preview.stats.updateCount ?? 0) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 truncate">{COPY[kind].title}</h1>
        <p className="text-gray-500 mt-1">{COPY[kind].intro}</p>
      </div>

      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-1 text-sm" role="tablist">
        {KINDS.map(({ kind: k, label }) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => reset(k)}
            className={`px-3 py-1.5 rounded-md ${kind === k ? "bg-purple-600 text-white" : "text-gray-600 hover:bg-gray-50"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <Stepper step={step} />

      {step === "download" && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-3">
          <h2 className="font-semibold flex items-center gap-2">
            <FileText className="w-4 h-4 text-purple-600" /> 1. Prepara el archivo
          </h2>
          <p className="text-sm text-gray-500">Columnas que reconocemos: {COPY[kind].columns}</p>
          <p className="text-sm text-gray-500">
            Si vienes de otro programa, exporta tus{" "}
            {kind === "clients" ? "clientas" : kind === "services" ? "servicios" : "citas pendientes (la agenda)"} a CSV o
            Excel (guárdalo como CSV) y súbelo tal cual. Si empiezas de cero, usa la plantilla.
          </p>
          {kind === "appointments" && (
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                className="mt-0.5 w-4 h-4"
                checked={sendReminders}
                onChange={(e) => setSendReminders(e.target.checked)}
              />
              <span>
                Enviar los recordatorios de estas citas desde KiraRoom
                <span className="block text-xs text-gray-500">
                  Desmárcalo si tu programa anterior todavía los envía, para que las clientas no reciban dos.
                </span>
              </span>
            </label>
          )}
          <button
            onClick={downloadTemplate}
            className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Descargar plantilla
          </button>
          <div className="flex flex-wrap items-center justify-end gap-3 pt-3">
            <button onClick={() => setStep("upload")} className="text-purple-600 hover:underline">
              Siguiente →
            </button>
          </div>
        </div>
      )}

      {step === "upload" && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-3">
          <h2 className="font-semibold flex items-center gap-2">
            <Upload className="w-4 h-4 text-purple-600" /> 2. Sube el archivo
          </h2>
          <label className="block border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-purple-400">
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-label="Archivo CSV"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            {file ? (
              <div>
                <Check className="w-8 h-8 text-green-600 mx-auto mb-2" />
                <div className="font-medium">{file.name}</div>
                <div className="text-xs text-gray-500">{(file.size / 1024).toFixed(1)} KB</div>
              </div>
            ) : (
              <div className="text-gray-500">Haz clic para elegir el archivo CSV</div>
            )}
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button onClick={() => setStep("download")} className="text-gray-500">
              ← Atrás
            </button>
            <button
              onClick={runDryRun}
              disabled={!csv || busy}
              className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 disabled:opacity-50"
            >
              {busy ? "Leyendo…" : "Previsualizar"}
            </button>
          </div>
        </div>
      )}

      {step === "preview" && preview && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <h2 className="font-semibold">3. Revisa antes de importar</h2>
          {kind === "appointments" ? (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <Stat label="Filas" value={preview.stats.totalRows} />
              <Stat label="Citas nuevas" value={preview.stats.okCount} color="green" />
              <Stat label="Ya en tu agenda" value={preview.stats.duplicateCount} color="yellow" />
              <Stat label="Pasadas o canceladas" value={preview.stats.skipCount ?? 0} />
              <Stat label="Con errores" value={preview.stats.invalidCount} color="red" />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
              <Stat label="Filas" value={preview.stats.totalRows} />
              <Stat label="Nuevos" value={preview.stats.okCount} color="green" />
              <Stat label="A actualizar" value={preview.stats.updateCount ?? 0} color="green" />
              <Stat label="Ya existen o repetidos" value={preview.stats.duplicateCount} color="yellow" />
              <Stat label="Con errores" value={preview.stats.invalidCount} color="red" />
            </div>
          )}
          {kind === "appointments" && (
            <p className="text-sm text-gray-600">
              {preview.newClients === 1
                ? "Se creará 1 clienta nueva (no estaba en KiraRoom). "
                : preview.newClients
                  ? `Se crearán ${preview.newClients} clientas nuevas (no estaban en KiraRoom). `
                  : ""}
              No se enviará ninguna confirmación.{" "}
              {sendReminders
                ? "Los recordatorios saldrán como en cualquier cita."
                : "No se enviarán recordatorios de estas citas."}
            </p>
          )}
          {preview.stats.totalRows > preview.preview.length && (
            <p className="text-xs text-gray-500">Se muestran las primeras {preview.preview.length} filas.</p>
          )}
          <div className="overflow-x-auto border rounded">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="whitespace-nowrap px-2 py-1 text-left">Fila</th>
                  {kind === "appointments" ? (
                    <>
                      <th className="whitespace-nowrap px-2 py-1 text-left">Fecha y hora</th>
                      <th className="whitespace-nowrap px-2 py-1 text-left">Cliente</th>
                      <th className="whitespace-nowrap px-2 py-1 text-left">Servicio</th>
                      <th className="whitespace-nowrap px-2 py-1 text-left">Profesional</th>
                    </>
                  ) : kind === "clients" ? (
                    <>
                      <th className="whitespace-nowrap px-2 py-1 text-left">Nombre</th>
                      <th className="whitespace-nowrap px-2 py-1 text-left">Teléfono</th>
                      <th className="whitespace-nowrap px-2 py-1 text-left">Email</th>
                    </>
                  ) : (
                    <>
                      <th className="whitespace-nowrap px-2 py-1 text-left">Servicio</th>
                      <th className="whitespace-nowrap px-2 py-1 text-left">Duración</th>
                      <th className="whitespace-nowrap px-2 py-1 text-left">Precio</th>
                    </>
                  )}
                  <th className="whitespace-nowrap px-2 py-1 text-left">Estado</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((row: ImportPreviewRow) => (
                  <tr
                    key={row.rowIndex}
                    className={row.status === "invalid" ? "bg-red-50" : row.status === "duplicate" ? "bg-yellow-50" : ""}
                  >
                    <td className="px-2 py-1">{row.rowIndex}</td>
                    {kind === "appointments" ? (
                      <>
                        <td className="px-2 py-1 whitespace-nowrap">
                          {row.data.date ? row.data.date.split("-").reverse().join("/") : "—"} {row.data.time ?? ""}
                        </td>
                        <td className="px-2 py-1">{row.data.clientName || "—"}</td>
                        <td className="px-2 py-1">{row.data.service || "—"}</td>
                        <td className="px-2 py-1">{row.data.professional || "—"}</td>
                      </>
                    ) : kind === "clients" ? (
                      <>
                        <td className="px-2 py-1">
                          {row.data.firstName} {row.data.lastName}
                        </td>
                        <td className="px-2 py-1">{row.data.phone || "—"}</td>
                        <td className="px-2 py-1">{row.data.email || "—"}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-2 py-1">{row.data.name}</td>
                        <td className="px-2 py-1">{row.data.duration ? `${row.data.duration} min` : "—"}</td>
                        <td className="px-2 py-1">{row.data.price !== undefined ? `${row.data.price} €` : "—"}</td>
                      </>
                    )}
                    <td className="px-2 py-1">
                      <StatusBadge status={row.status} kind={kind} />
                      {row.note && <div className="text-xs text-gray-500 mt-1">{row.note}</div>}
                      {row.errors.length > 0 && (
                        <div className="text-xs text-red-600 mt-1">
                          {row.errors.map((e) => `${e.col}: ${e.msg}`).join("; ")}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <button onClick={() => setStep("upload")} className="text-gray-500">
              ← Atrás
            </button>
            <button
              onClick={runCommit}
              disabled={busy || importable === 0}
              className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? "Importando…" : `Importar ${importable}`}
            </button>
          </div>
        </div>
      )}

      {step === "done" && commit && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-3 text-center">
          <Check className="w-12 h-12 text-green-600 mx-auto" />
          <h2 className="text-xl font-semibold">Importación completada</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 max-w-xl mx-auto">
            <Stat label="Filas" value={commit.totalRows} />
            <Stat label="Creados" value={commit.createdRows ?? commit.successRows} color="green" />
            <Stat label="Actualizados" value={commit.updatedRows ?? 0} color="green" />
            <Stat label="Saltados" value={commit.skippedRows} color="yellow" />
          </div>
          {kind === "appointments" && (
            <p className="text-sm text-gray-600">
              Ya están en tu agenda.
              {commit.newClients === 1
                ? " Se ha creado 1 clienta nueva."
                : commit.newClients
                  ? ` Se han creado ${commit.newClients} clientas nuevas.`
                  : ""}{" "}
              <a href="/dashboard/appointments" className="text-purple-600 hover:underline">
                Ver la agenda
              </a>
            </p>
          )}
          {commit.errorRows > 0 && (
            <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700 flex items-start gap-2 justify-center">
              <AlertTriangle className="w-4 h-4" />
              {commit.errorRows} filas con errores no se importaron.
            </div>
          )}
          <button onClick={() => reset(kind)} className="text-purple-600 hover:underline text-sm">
            Importar otro archivo
          </button>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status, kind }: { status: ImportPreviewRow["status"]; kind: Kind }) {
  const map = {
    ok: [kind === "appointments" ? "Nueva" : "Nuevo", "bg-green-100 text-green-700"],
    update: ["Se actualiza", "bg-green-100 text-green-700"],
    duplicate: [kind === "appointments" ? "Ya en la agenda" : "Ya existe", "bg-yellow-100 text-yellow-700"],
    invalid: ["Error", "bg-red-100 text-red-700"],
    skip: ["Se omite", "bg-gray-100 text-gray-600"],
  } as const;
  const [label, cls] = map[status] ?? [status, "bg-gray-100"];
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{label}</span>;
}

function Stepper({ step }: { step: Step }) {
  const items: Array<{ key: Step; label: string }> = [
    { key: "download", label: "Archivo" },
    { key: "upload", label: "Subir" },
    { key: "preview", label: "Revisar" },
    { key: "done", label: "Listo" },
  ];
  const currentIdx = items.findIndex((i) => i.key === step);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
      {items.map((it, i) => (
        <li key={it.key} className={`flex items-center gap-2 ${i <= currentIdx ? "text-purple-600 font-medium" : ""}`}>
          <span
            className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
              i <= currentIdx ? "bg-purple-600 text-white" : "bg-gray-200 text-gray-600"
            }`}
          >
            {i + 1}
          </span>
          {it.label}
        </li>
      ))}
    </ol>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: "green" | "yellow" | "red" }) {
  const colors: Record<string, string> = {
    green: "bg-green-50 text-green-700 border-green-200",
    yellow: "bg-yellow-50 text-yellow-700 border-yellow-200",
    red: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <div className={`border rounded-lg p-3 text-center ${color ? colors[color] : "bg-gray-50"}`}>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs uppercase tracking-wide">{label}</div>
    </div>
  );
}

export default function ImportPage() {
  return (
    <Suspense fallback={null}>
      <ImportPageContent />
    </Suspense>
  );
}
