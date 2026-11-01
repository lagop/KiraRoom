"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import apiClient from "@/lib/api";
import { MIN_PASSWORD, passwordProblem } from "@/lib/panel-access";

const input =
  "w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500";
const primary = "px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50";

/**
 * The signed-in panel user's own password: the current one and a new one.
 * There was no way to change it, so a professional kept the first password
 * the owner chose and handed over. Other devices are signed out; this one
 * stays signed in.
 */
export function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDone(false);
    if (!current) {
      setError("Escribe tu contraseña actual.");
      return;
    }
    const problem = passwordProblem(next, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    if (next === current) {
      setError("La contraseña nueva tiene que ser distinta de la actual.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiClient.changeOwnPassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "No se ha podido cambiar la contraseña.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-6 max-w-2xl space-y-4">
      <div className="flex items-start gap-3">
        <KeyRound className="w-6 h-6 text-gray-400 shrink-0" aria-hidden />
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Cambiar contraseña</h2>
          <p className="text-sm text-gray-600">
            Si te la dio otra persona al darte acceso, cámbiala por una que solo sepas tú. Se cerrará la sesión en
            tus otros dispositivos; en este sigues dentro.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <input
          className={input}
          type="password"
          autoComplete="current-password"
          placeholder="Contraseña actual"
          aria-label="Contraseña actual"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            className={input}
            type="password"
            autoComplete="new-password"
            placeholder={`Contraseña nueva (mínimo ${MIN_PASSWORD})`}
            aria-label="Contraseña nueva"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <input
            className={input}
            type="password"
            autoComplete="new-password"
            placeholder="Repite la contraseña nueva"
            aria-label="Repite la contraseña nueva"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="text-sm text-green-700">
            Contraseña cambiada. Tus otros dispositivos tendrán que volver a entrar.
          </p>
        )}
        <button type="submit" className={primary} disabled={busy}>
          {busy ? "Guardando…" : "Cambiar contraseña"}
        </button>
      </form>
    </section>
  );
}
