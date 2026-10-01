"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, Upload, Check, AlertTriangle, FileText } from "lucide-react";
import apiClient, { ImportPreviewRow, ImportPreviewResult, ImportCommitResult } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

type Step = "download" | "upload" | "preview" | "done";
type Kind = "clients" | "services";

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
  const [kind, setKind] = useState<Kind>(params?.get("tipo") === "servicios" ? "services" : "clients");
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
        kind === "clients" ? await apiClient.dryRunImportClients(csv, name) : await apiClient.dryRunImportServices(csv, name),
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
        kind === "clients" ? await apiClient.commitImportClients(csv, name) : await apiClient.commitImportServices(csv, name),
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
        {(["clients", "services"] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => reset(k)}
            className={`px-3 py-1.5 rounded-md ${kind === k ? "bg-purple-600 text-white" : "text-gray-600 hover:bg-gray-50"}`}
          >
            {k === "clients" ? "Clientes" : "Servicios"}
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
            Si vienes de otro programa, exporta tus {kind === "clients" ? "clientas" : "servicios"} a CSV o Excel (guárdalo
            como CSV) y súbelo tal cual. Si empiezas de cero, usa la plantilla.
          </p>
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
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Filas" value={preview.stats.totalRows} />
            <Stat label="Nuevos" value={preview.stats.okCount} color="green" />
            <Stat label="A actualizar" value={preview.stats.updateCount ?? 0} color="green" />
            <Stat label="Ya existen o repetidos" value={preview.stats.duplicateCount} color="yellow" />
            <Stat label="Con errores" value={preview.stats.invalidCount} color="red" />
          </div>
          {preview.stats.totalRows > preview.preview.length && (
            <p className="text-xs text-gray-500">Se muestran las primeras {preview.preview.length} filas.</p>
          )}
          <div className="overflow-x-auto border rounded">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="whitespace-nowrap px-2 py-1 text-left">Fila</th>
                  {kind === "clients" ? (
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
                    {kind === "clients" ? (
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
                      <StatusBadge status={row.status} />
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

function StatusBadge({ status }: { status: ImportPreviewRow["status"] }) {
  const map = {
    ok: ["Nuevo", "bg-green-100 text-green-700"],
    update: ["Se actualiza", "bg-green-100 text-green-700"],
    duplicate: ["Ya existe", "bg-yellow-100 text-yellow-700"],
    invalid: ["Error", "bg-red-100 text-red-700"],
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
