"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, Trash2 } from "lucide-react";
import apiClient, { SalonDeletionStatus, SalonExportKind } from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";
import { ConfirmDialog } from "@/src/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";

const input =
  "w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500";
const secondary =
  "inline-flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50";
const danger = "px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50";

const EXPORTS: Array<{ kind: SalonExportKind; label: string }> = [
  { kind: "clients", label: "Clientas" },
  { kind: "appointments", label: "Citas" },
  { kind: "payments", label: "Pagos" },
  { kind: "services", label: "Servicios" },
  { kind: "professionals", label: "Equipo" },
  { kind: "gift-cards", label: "Tarjetas regalo" },
];

const longDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" }) : "";

function saveFile(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/**
 * "Borrar mi salón" (owner only, audit 7 D7). The exports first; then the
 * password (and the 2FA code): the salon goes read-only now, with 30 days
 * to export, and its personal data is anonymised 30 days after. Nothing more
 * is charged. While it is pending the owner can cancel it.
 */
export function DeleteSalonSettings() {
  const { toast } = useToast();
  const [isOwner, setIsOwner] = useState(false);
  const [status, setStatus] = useState<SalonDeletionStatus | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<SalonExportKind | null>(null);
  const [confirming, setConfirming] = useState<"request" | "cancel" | null>(null);

  // Read after mount: the token is in localStorage (render-time-user.spec).
  useEffect(() => {
    const owner = getCurrentUser()?.role === "owner";
    setIsOwner(owner);
    if (!owner) return;
    apiClient
      .getSalonDeletion()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  if (!isOwner || !status) return null;

  const download = async (kind: SalonExportKind) => {
    setDownloading(kind);
    try {
      const { blob, filename } = await apiClient.downloadSalonExport(kind);
      saveFile(blob, filename);
    } catch (err) {
      toast({
        title: "No se ha podido descargar el archivo",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setDownloading(null);
    }
  };

  const askToConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError("Escribe tu contraseña.");
      return;
    }
    if (status.twoFactorRequired && !code.trim()) {
      setError("Escribe el código de tu app de verificación.");
      return;
    }
    setError("");
    setConfirming("request");
  };

  const requestDeletion = async () => {
    setBusy(true);
    try {
      const next = await apiClient.requestSalonDeletion(password, code.trim() || undefined);
      setStatus(next);
      setPassword("");
      setCode("");
      setConfirming(null);
      toast({ title: "Hemos recibido tu petición", description: "Tu salón queda en solo lectura." });
    } catch (err) {
      setConfirming(null);
      setError(err instanceof Error && err.message ? err.message : "No se ha podido pedir el borrado.");
    } finally {
      setBusy(false);
    }
  };

  const cancelDeletion = async () => {
    setBusy(true);
    try {
      setStatus(await apiClient.cancelSalonDeletion());
      setConfirming(null);
      toast({ title: "Borrado anulado", description: "Tu salón sigue en KiraRoom." });
    } catch (err) {
      setConfirming(null);
      toast({
        title: "No se ha podido anular el borrado",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white rounded-xl border border-red-200 p-6 max-w-2xl space-y-4">
      <div className="flex items-start gap-3">
        <Trash2 className="w-6 h-6 text-red-500 shrink-0" aria-hidden />
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Borrar mi salón</h2>
          <p className="text-sm text-gray-600">
            Tu salón queda en solo lectura: tienes 30 días para exportar tus datos y, 30 días después, se anonimizan
            los datos personales del salón, del equipo y de las clientas. Te avisamos por email 7 días antes. Las
            facturas emitidas se conservan, como exige la ley. No se te cobra nada más.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-900">Antes, descarga tus datos</p>
        <div className="flex flex-wrap gap-2">
          {EXPORTS.map(({ kind, label }) => (
            <button key={kind} type="button" className={secondary} disabled={downloading !== null} onClick={() => download(kind)}>
              {downloading === kind ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Download className="w-4 h-4" aria-hidden />}
              {label} (CSV)
            </button>
          ))}
        </div>
      </div>

      {status.pending ? (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 space-y-3">
          <p className="text-sm text-red-800">
            Has pedido borrar tu salón. Puedes exportar tus datos hasta el {longDate(status.exportUntil)}; después se
            anonimizan, el {longDate(status.anonymizeOn)}.
          </p>
          <button type="button" className={secondary} disabled={busy} onClick={() => setConfirming("cancel")}>
            Anular el borrado
          </button>
        </div>
      ) : (
        <form onSubmit={askToConfirm} className="space-y-3">
          <input
            className={input}
            type="password"
            autoComplete="current-password"
            placeholder="Tu contraseña"
            aria-label="Tu contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {status.twoFactorRequired && (
            <input
              className={input}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Código de tu app de verificación"
              aria-label="Código de tu app de verificación"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          )}
          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className={danger} disabled={busy}>
            Borrar mi salón
          </button>
        </form>
      )}

      <ConfirmDialog
        open={confirming === "request"}
        title="¿Borrar tu salón?"
        description="Tu salón pasa a solo lectura ahora mismo. Tendrás 30 días para exportar tus datos y 30 días después se anonimizan. Mientras tanto puedes anular el borrado."
        confirmLabel="Sí, borrar mi salón"
        destructive
        loading={busy}
        onCancel={() => setConfirming(null)}
        onConfirm={requestDeletion}
      />
      <ConfirmDialog
        open={confirming === "cancel"}
        title="¿Anular el borrado?"
        description="Tu salón vuelve a estar como antes. Si tenías una suscripción, se renovará como siempre."
        confirmLabel="Anular el borrado"
        loading={busy}
        onCancel={() => setConfirming(null)}
        onConfirm={cancelDeletion}
      />
    </section>
  );
}
