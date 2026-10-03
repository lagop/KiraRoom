"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileKey, Loader2, Upload } from "lucide-react";
import apiClient, { VerifactuStatus } from "@/lib/api";

/** A file's bytes as base64, for the certificate upload. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" }) : "";

/**
 * VERI*FACTU in the fiscal settings: the certificate the invoices are sent
 * with, and the state of the salon's queue at the AEAT.
 */
export function VerifactuCard() {
  const qc = useQueryClient();
  const status = useQuery<VerifactuStatus>({
    queryKey: ["verifactu", "status"],
    queryFn: () => apiClient.getVerifactuStatus(),
    refetchInterval: 30_000,
  });

  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [seal, setSeal] = useState(false);
  const upload = useMutation({
    mutationFn: async () =>
      apiClient.uploadFiscalCertificate({
        alias: file!.name,
        pkcs12Base64: await toBase64(file!),
        passphrase: password,
        certificateType: seal ? "seal" : "personal",
      }),
    onSuccess: () => {
      setFile(null);
      setPassword("");
      qc.invalidateQueries({ queryKey: ["verifactu"] });
      qc.invalidateQueries({ queryKey: ["invoices", "certificates"] });
    },
  });

  const s = status.data;
  if (!s) return null;
  const waiting = s.pending > 0 && (s.incidentSince || s.lastError);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-gray-900">VERI*FACTU</h2>
        {s.available && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              s.environment === "production" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"
            }`}
          >
            {s.environment === "production" ? "Envío real a la AEAT" : "Entorno de pruebas de la AEAT"}
          </span>
        )}
      </div>

      {!s.available ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          El envío de facturas a la AEAT con VERI*FACTU todavía no está disponible en KiraRoom.
        </p>
      ) : (
        <p className="text-sm text-gray-600">
          Con VERI*FACTU, cada factura genera un registro que se envía automáticamente a la AEAT, y la factura lleva un
          código QR para que tu cliente pueda comprobarla. Para activarlo necesitas el NIF del salón y un certificado
          electrónico (de la persona titular, de la empresa o de sello). Una vez activado, se mantiene hasta el 31 de
          diciembre.
        </p>
      )}

      {s.active && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Count label="Aceptadas" value={s.accepted} tone="green" />
          <Count label="Con avisos" value={s.acceptedWithErrors} tone="amber" />
          <Count label="Pendientes de envío" value={s.pending} tone={waiting ? "amber" : "gray"} />
          <Count label="Rechazadas" value={s.rejected} tone={s.rejected ? "red" : "gray"} />
        </div>
      )}

      {s.active && waiting && (
        <div className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {s.pending} {s.pending === 1 ? "registro está" : "registros están"} pendientes de enviar a la AEAT
            {s.incidentSince ? ` desde el ${when(s.incidentSince)}` : ""}. Se reintenta automáticamente
            {s.nextSendAt ? ` (próximo intento: ${when(s.nextSendAt)})` : ""}. Puedes seguir facturando.
            {s.lastError && <div className="mt-1 text-xs text-amber-800">{s.lastError}</div>}
          </div>
        </div>
      )}
      {s.active && s.rejected > 0 && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          La AEAT ha rechazado {s.rejected} {s.rejected === 1 ? "registro" : "registros"}. En Facturas verás el motivo
          y podrás reenviarlas corregidas.
        </p>
      )}

      <div className="space-y-3 border-t border-gray-100 pt-4">
        <h3 className="flex items-center gap-2 text-sm font-medium text-gray-900">
          <FileKey className="h-4 w-4 text-violet-600" /> Certificado electrónico
        </h3>
        {s.certificate ? (
          <p className="flex items-start gap-2 text-sm text-gray-700">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
            <span>
              {s.certificate.subject ?? s.certificate.alias}
              {s.certificate.notAfter && (
                <span className="text-gray-500"> · caduca el {new Date(s.certificate.notAfter).toLocaleDateString("es-ES")}</span>
              )}
              {s.certificate.certificateType === "seal" && <span className="text-gray-500"> · de sello</span>}
            </span>
          </p>
        ) : s.platformCertificate ? (
          <p className="text-sm text-gray-600">Las facturas se envían con el certificado de KiraRoom como colaborador social.</p>
        ) : (
          <p className="text-sm text-gray-600">Todavía no has subido ningún certificado.</p>
        )}

        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="block text-sm">
            <span className="text-gray-700">Archivo .p12 o .pfx</span>
            <input
              type="file"
              accept=".p12,.pfx,application/x-pkcs12"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-gray-700">Contraseña del certificado</span>
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <button
            type="button"
            disabled={!file || !password || upload.isPending}
            onClick={() => upload.mutate()}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {upload.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Subir
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={seal} onChange={(e) => setSeal(e.target.checked)} className="h-4 w-4" />
          Es un certificado de sello
        </label>
        {upload.isError && <p className="text-sm text-red-600">{(upload.error as Error).message}</p>}
        {upload.data && (
          <p className={`text-sm ${upload.data.nifMatchesSalon === false ? "text-amber-700" : "text-green-700"}`}>
            Certificado guardado.
            {upload.data.nifMatchesSalon === false &&
              " Su NIF no es el del salón: solo funcionará si su titular es representante o colaborador social del salón ante la AEAT."}
          </p>
        )}
        <p className="text-xs text-gray-500">
          El certificado se guarda cifrado y solo se usa para enviar tus facturas a la AEAT. Puedes ver la{" "}
          <a href="/legal/verifactu" target="_blank" rel="noopener noreferrer" className="text-violet-700 underline">
            declaración responsable del sistema
          </a>
          .
        </p>
      </div>
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: "green" | "amber" | "red" | "gray" }) {
  const tones = {
    green: "bg-green-50 text-green-800",
    amber: "bg-amber-50 text-amber-800",
    red: "bg-red-50 text-red-800",
    gray: "bg-gray-50 text-gray-700",
  };
  return (
    <div className={`rounded-lg p-3 text-center ${tones[tone]}`}>
      <div className="text-xl font-semibold">{value}</div>
      <div className="text-xs">{label}</div>
    </div>
  );
}
