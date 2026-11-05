"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import apiClient from "@/lib/api";

interface TwoFactorStepProps {
  challenge: string;
  /** Called with the session once the code is right (same shape as login). */
  onSignedIn: (response: Awaited<ReturnType<typeof apiClient.verifyTwoFactor>>) => void;
  /** Back to the email and password (also when the 5 minutes run out). */
  onCancel: () => void;
  /** Tailwind colour of the button, to match each login page. */
  accent?: "purple" | "slate";
}

/**
 * Second step of signing in when the account has two-step verification:
 * the 6-digit code from the authenticator app, or a recovery code.
 */
export function TwoFactorStep({ challenge, onSignedIn, onCancel, accent = "purple" }: TwoFactorStepProps) {
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      onSignedIn(await apiClient.verifyTwoFactor(challenge, code));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se ha podido comprobar el código.");
      setCode("");
    } finally {
      setLoading(false);
    }
  };

  const button =
    accent === "slate" ? "bg-slate-900 hover:bg-slate-800" : "bg-purple-600 hover:bg-purple-700";

  return (
    <form onSubmit={submit} className="space-y-4" aria-labelledby="two-factor-title">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-green-600" aria-hidden />
        <h2 id="two-factor-title" className="text-lg font-semibold text-gray-900">
          Verificación en dos pasos
        </h2>
      </div>
      <p className="text-sm text-gray-600">
        {useRecovery
          ? "Escribe uno de tus códigos de recuperación. Cada uno sirve una sola vez."
          : "Abre tu app de autenticación y escribe el código de 6 cifras de KiraRoom."}
      </p>

      <div>
        <label htmlFor="two-factor-code" className="block text-sm font-medium text-gray-700 mb-1">
          {useRecovery ? "Código de recuperación" : "Código"}
        </label>
        <input
          id="two-factor-code"
          type="text"
          inputMode={useRecovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoFocus
          required
          maxLength={20}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={useRecovery ? "xxxx-xxxx" : "123456"}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-purple-500"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading || code.trim().length < 6}
        className={`w-full py-2 px-4 text-white rounded-lg font-medium disabled:opacity-50 ${button}`}
      >
        {loading ? "Comprobando…" : "Entrar"}
      </button>

      <div className="flex justify-between text-sm">
        <button
          type="button"
          className="text-purple-700 hover:underline"
          onClick={() => {
            setUseRecovery(!useRecovery);
            setCode("");
            setError("");
          }}
        >
          {useRecovery ? "Usar el código de la app" : "No tengo el móvil: usar un código de recuperación"}
        </button>
        <button type="button" className="text-gray-600 hover:underline" onClick={onCancel}>
          Volver
        </button>
      </div>
    </form>
  );
}
