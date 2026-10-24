"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ShieldCheck, ShieldOff, Copy, Download, Loader2 } from "lucide-react";
import apiClient, { type TwoFactorStatus } from "@/lib/api";
import { recoveryCodesFile } from "@/lib/two-factor";

type Step =
  | { kind: "idle" }
  | { kind: "scan"; secret: string; qr: string }
  | { kind: "codes"; codes: string[] }
  | { kind: "disable" }
  | { kind: "regenerate" };

const input =
  "w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500";
const primary = "px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50";
const secondary = "px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50";

/**
 * Two-step verification for the signed-in panel user: turn it on with an
 * authenticator app (QR code, then a first code to confirm), see and replace
 * the recovery codes, and turn it off with the password and a code.
 */
export function TwoFactorSettings() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = () =>
    apiClient
      .getTwoFactorStatus()
      .then(setStatus)
      .catch((e) => setError(e instanceof Error ? e.message : "No se ha podido cargar."));

  useEffect(() => {
    refresh();
  }, []);

  const reset = () => {
    setStep({ kind: "idle" });
    setCode("");
    setPassword("");
    setError("");
    setCopied(false);
  };

  const run = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Algo ha fallado. Inténtalo de nuevo.");
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      const { secret, otpauthUrl } = await apiClient.setupTwoFactor();
      const qr = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
      setStep({ kind: "scan", secret, qr });
    });

  const confirm = () =>
    run(async () => {
      const { recoveryCodes } = await apiClient.enableTwoFactor(code);
      setCode("");
      setStep({ kind: "codes", codes: recoveryCodes });
      await refresh();
    });

  const disable = () =>
    run(async () => {
      setStatus(await apiClient.disableTwoFactor(password, code));
      reset();
    });

  const regenerate = () =>
    run(async () => {
      const { recoveryCodes } = await apiClient.regenerateRecoveryCodes(code);
      setCode("");
      setStep({ kind: "codes", codes: recoveryCodes });
      await refresh();
    });

  const download = (codes: string[]) => {
    const blob = new Blob([recoveryCodesFile(codes, new Date())], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kiraroom-codigos-de-recuperacion.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  if (!status) {
    return (
      <div className="flex items-center gap-2 text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin" /> Cargando…
        {error && <span className="text-red-600">{error}</span>}
      </div>
    );
  }

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-6 max-w-2xl space-y-4">
      <div className="flex items-start gap-3">
        {status.enabled ? (
          <ShieldCheck className="w-6 h-6 text-green-600 shrink-0" aria-hidden />
        ) : (
          <ShieldOff className="w-6 h-6 text-gray-400 shrink-0" aria-hidden />
        )}
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Verificación en dos pasos</h2>
          <p className="text-sm text-gray-600">
            {status.enabled
              ? `Activada. Al entrar se te pide la contraseña y un código de tu app de autenticación. Te quedan ${status.recoveryCodesLeft} códigos de recuperación.`
              : "Desactivada. Actívala para que, aunque alguien conozca tu contraseña, no pueda entrar sin tu móvil."}
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      {step.kind === "idle" && !status.enabled && (
        <button className={primary} onClick={start} disabled={busy}>
          Activar
        </button>
      )}

      {step.kind === "idle" && status.enabled && (
        <div className="flex flex-wrap gap-2">
          <button className={secondary} onClick={() => setStep({ kind: "regenerate" })}>
            Nuevos códigos de recuperación
          </button>
          <button className={secondary} onClick={() => setStep({ kind: "disable" })}>
            Desactivar
          </button>
        </div>
      )}

      {step.kind === "scan" && (
        <div className="space-y-4">
          <ol className="list-decimal pl-5 text-sm text-gray-700 space-y-1">
            <li>Abre una app de autenticación en tu móvil (Google Authenticator, Microsoft Authenticator, Authy…).</li>
            <li>Añade una cuenta escaneando este código QR.</li>
            <li>Escribe el código de 6 cifras que te muestra para KiraRoom.</li>
          </ol>
          <img src={step.qr} alt="Código QR para la app de autenticación" width={220} height={220} />
          <p className="text-xs text-gray-500">
            ¿No puedes escanearlo? Escribe esta clave en la app: <code className="break-all">{step.secret}</code>
          </p>
          <div className="flex gap-2 max-w-sm">
            <input
              className={input}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-label="Código de la app"
            />
            <button className={primary} onClick={confirm} disabled={busy || code.trim().length !== 6}>
              Confirmar
            </button>
          </div>
          <button className="text-sm text-gray-600 hover:underline" onClick={reset}>
            Cancelar
          </button>
        </div>
      )}

      {step.kind === "codes" && (
        <div className="space-y-3">
          <p className="text-sm text-gray-700">
            <strong>Guarda estos códigos de recuperación</strong> en un sitio seguro. Si pierdes el móvil, cada uno te
            deja entrar una vez. No se volverán a mostrar.
          </p>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm bg-gray-50 p-4 rounded-lg max-w-sm">
            {step.codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              className={secondary}
              onClick={async () => {
                await navigator.clipboard.writeText(step.codes.join("\n"));
                setCopied(true);
              }}
            >
              <Copy className="w-4 h-4 inline mr-1" aria-hidden />
              {copied ? "Copiados" : "Copiar"}
            </button>
            <button className={secondary} onClick={() => download(step.codes)}>
              <Download className="w-4 h-4 inline mr-1" aria-hidden />
              Descargar
            </button>
            <button className={primary} onClick={reset}>
              Ya los he guardado
            </button>
          </div>
        </div>
      )}

      {(step.kind === "disable" || step.kind === "regenerate") && (
        <div className="space-y-3 max-w-sm">
          {step.kind === "disable" && (
            <input
              className={input}
              type="password"
              autoComplete="current-password"
              placeholder="Tu contraseña"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-label="Contraseña"
            />
          )}
          <input
            className={input}
            autoComplete="one-time-code"
            placeholder="Código de la app o de recuperación"
            maxLength={20}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-label="Código"
          />
          <div className="flex gap-2">
            <button
              className={primary}
              onClick={step.kind === "disable" ? disable : regenerate}
              disabled={busy || code.trim().length < 6 || (step.kind === "disable" && !password)}
            >
              {step.kind === "disable" ? "Desactivar" : "Generar códigos nuevos"}
            </button>
            <button className={secondary} onClick={reset}>
              Cancelar
            </button>
          </div>
          {step.kind === "regenerate" && (
            <p className="text-xs text-gray-500">Los códigos anteriores dejarán de servir.</p>
          )}
        </div>
      )}
    </section>
  );
}
