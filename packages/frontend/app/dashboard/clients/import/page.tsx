"use client";

import { useState } from "react";
import { Download, Upload, Check, AlertTriangle, FileText } from "lucide-react";
import apiClient, {
  ImportPreviewRow,
  ImportPreviewResult,
  ImportCommitResult,
} from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

type Step = "download" | "upload" | "preview" | "commit" | "done";

export default function ImportClientsPage() {
  const { toast } = useToast();
  const [step, setStep] = useState<Step>("download");
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState<string>("");
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [commit, setCommit] = useState<ImportCommitResult | null>(null);
  const [busy, setBusy] = useState(false);

  function downloadTemplate() {
    window.open(apiClient.getImportTemplateUrl(), "_blank");
  }

  async function handleFile(f: File) {
    setFile(f);
    const text = await f.text();
    setCsv(text);
  }

  async function runDryRun() {
    if (!csv) return;
    setBusy(true);
    try {
      const result = await apiClient.dryRunImportClients(
        csv,
        file?.name ?? "upload.csv",
      );
      setPreview(result);
      setStep("preview");
    } catch (err: any) {
      toast({
        title: "Error procesando CSV",
        description: err?.message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  async function runCommit() {
    if (!csv) return;
    setBusy(true);
    try {
      const result = await apiClient.commitImportClients(
        csv,
        file?.name ?? "upload.csv",
      );
      setCommit(result);
      setStep("done");
      toast({ title: "Importación completada" });
    } catch (err: any) {
      toast({
        title: "Error importando",
        description: err?.message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 truncate">Importar clientes</h1>
        <p className="text-gray-500 mt-1">
          Carga un CSV de clientes. Detectamos duplicados por email y permitimos
          previsualizar antes de confirmar.
        </p>
      </div>

      <Stepper step={step} />

      {step === "download" && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-3">
          <h2 className="font-semibold flex items-center gap-2">
            <FileText className="w-4 h-4 text-purple-600" /> 1. Descarga la
            plantilla
          </h2>
          <p className="text-sm text-gray-500">
            Columnas: <code>firstName, lastName, email, phone, dateOfBirth,
            gender, notes, _action</code>. La columna <code>_action</code> acepta
            <code> insert</code>, <code>update</code> o <code>skip</code>{" "}
            (default <code>insert</code>).
          </p>
          <button
            onClick={downloadTemplate}
            className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Descargar plantilla CSV
          </button>
           <div className="flex flex-wrap items-center justify-end gap-3 pt-3">
            <button
              onClick={() => setStep("upload")}
              className="text-purple-600 hover:underline"
            >
              Siguiente →
            </button>
          </div>
        </div>
      )}

      {step === "upload" && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-3">
          <h2 className="font-semibold flex items-center gap-2">
            <Upload className="w-4 h-4 text-purple-600" /> 2. Sube tu CSV
          </h2>
          <label className="block border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-purple-400">
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
            />
            {file ? (
              <div>
                <Check className="w-8 h-8 text-green-600 mx-auto mb-2" />
                <div className="font-medium">{file.name}</div>
                <div className="text-xs text-gray-500">
                  {(file.size / 1024).toFixed(1)} KB
                </div>
              </div>
            ) : (
              <div className="text-gray-500">
                Arrastra un archivo aquí o haz clic para seleccionarlo
              </div>
            )}
          </label>
           <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              onClick={() => setStep("download")}
              className="text-gray-500"
            >
              ← Atrás
            </button>
            <button
              onClick={runDryRun}
              disabled={!csv || busy}
              className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 disabled:opacity-50"
            >
              {busy ? "Procesando…" : "Previsualizar"}
            </button>
          </div>
        </div>
      )}

      {step === "preview" && preview && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
          <h2 className="font-semibold">3. Previsualización</h2>
           <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Filas" value={preview.stats.totalRows} />
            <Stat label="OK" value={preview.stats.okCount} color="green" />
            <Stat label="Duplicados" value={preview.stats.duplicateCount} color="yellow" />
            <Stat label="Con errores" value={preview.stats.invalidCount} color="red" />
          </div>
          <div className="overflow-x-auto border rounded">
             <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-gray-50">
                <tr>
                   <th className="whitespace-nowrap px-2 py-1 text-left">#</th>
                   <th className="whitespace-nowrap px-2 py-1 text-left">Email</th>
                   <th className="whitespace-nowrap px-2 py-1 text-left">Nombre</th>
                   <th className="whitespace-nowrap px-2 py-1 text-left">Estado</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((row: ImportPreviewRow) => (
                  <tr
                    key={row.rowIndex}
                    className={
                      row.status === "invalid"
                        ? "bg-red-50"
                        : row.status === "duplicate"
                          ? "bg-yellow-50"
                          : ""
                    }
                  >
                    <td className="px-2 py-1">{row.rowIndex}</td>
                    <td className="px-2 py-1">{row.data.email || "—"}</td>
                    <td className="px-2 py-1">
                      {row.data.firstName} {row.data.lastName}
                    </td>
                    <td className="px-2 py-1">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          row.status === "ok"
                            ? "bg-green-100 text-green-700"
                            : row.status === "duplicate"
                              ? "bg-yellow-100 text-yellow-700"
                              : "bg-red-100 text-red-700"
                        }`}
                      >
                        {row.status}
                      </span>
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
            <button
              onClick={() => setStep("upload")}
              className="text-gray-500"
            >
              ← Atrás
            </button>
            <button
              onClick={runCommit}
              disabled={busy || preview.stats.okCount === 0}
              className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? "Importando…" : `Confirmar importación (${preview.stats.okCount} OK)`}
            </button>
          </div>
        </div>
      )}

      {step === "done" && commit && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-3 text-center">
          <Check className="w-12 h-12 text-green-600 mx-auto" />
          <h2 className="text-xl font-semibold">Importación completada</h2>
           <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 max-w-md mx-auto">
            <Stat label="Procesadas" value={commit.totalRows} />
            <Stat label="Importadas" value={commit.successRows} color="green" />
            <Stat label="Saltadas" value={commit.skippedRows} color="yellow" />
          </div>
          {commit.errorRows > 0 && (
            <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700 flex items-start gap-2 justify-center">
              <AlertTriangle className="w-4 h-4" />
              {commit.errorRows} filas con error. Revisa el historial de
              importaciones.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const items: Array<{ key: Step; label: string }> = [
    { key: "download", label: "Plantilla" },
    { key: "upload", label: "Subir CSV" },
    { key: "preview", label: "Previsualizar" },
    { key: "done", label: "Listo" },
  ];
  const currentIdx = items.findIndex((i) => i.key === step);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
      {items.map((it, i) => (
        <li
          key={it.key}
          className={`flex items-center gap-2 ${
            i <= currentIdx ? "text-purple-600 font-medium" : ""
          }`}
        >
          <span
            className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
              i <= currentIdx
                ? "bg-purple-600 text-white"
                : "bg-gray-200 text-gray-600"
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

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: "green" | "yellow" | "red";
}) {
  const colors: Record<string, string> = {
    green: "bg-green-50 text-green-700 border-green-200",
    yellow: "bg-yellow-50 text-yellow-700 border-yellow-200",
    red: "bg-red-50 text-red-700 border-red-200",
  };
  return (
    <div
      className={`border rounded-lg p-3 text-center ${
        color ? colors[color] : "bg-gray-50"
      }`}
    >
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs uppercase tracking-wide">{label}</div>
    </div>
  );
}