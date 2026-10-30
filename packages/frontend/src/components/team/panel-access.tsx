"use client";

import { useEffect, useState } from "react";
import { KeyRound, Copy, UserX } from "lucide-react";
import apiClient from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  MIN_PASSWORD,
  type PanelAccess,
  accessInstructions,
  panelAccessText,
  passwordProblem,
} from "@/lib/panel-access";

interface PanelAccessBlockProps {
  professionalId: string;
  name: string;
  email?: string;
  access?: PanelAccess;
  /** Told after a change; the block already shows it (no reload needed). */
  onChanged?: () => void;
}

const input =
  "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500";

/**
 * A professional's own login to the panel, on their card in the team screen:
 * whether they have one, and giving it (with a first password the owner
 * hands over), changing the password or taking it away.
 */
export function PanelAccessBlock({ professionalId, name, email, access: initial, onChanged }: PanelAccessBlockProps) {
  // Kept here and updated in place: reloading the team list remounted the
  // cards and lost the instructions shown after giving access.
  const [access, setAccess] = useState<PanelAccess | undefined>(initial);
  useEffect(() => setAccess(initial), [initial]);
  const [form, setForm] = useState<null | "grant">(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Revoking is confirmed in the panel's dialog.
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const status = access?.status ?? "none";
  if (status === "owner") {
    return <p className="text-xs text-gray-500 mt-3">{panelAccessText(access)}</p>;
  }

  const close = () => {
    setForm(null);
    setPassword("");
    setConfirm("");
    setError("");
  };

  const grant = async () => {
    const problem = passwordProblem(password, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const out = await apiClient.grantProfessionalAccess(professionalId, password);
      const loginUrl = typeof window !== "undefined" ? `${window.location.origin}/login` : "/login";
      setInstructions(accessInstructions(out.email, loginUrl));
      setAccess({ status: "active", email: out.email, lastLoginAt: access?.status === "active" ? access.lastLoginAt : null });
      close();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se ha podido dar acceso.");
    } finally {
      setBusy(false);
    }
  };

  const performRevoke = async () => {
    setBusy(true);
    try {
      await apiClient.revokeProfessionalAccess(professionalId);
      setInstructions(null);
      setAccess({ status: "revoked", email: email ?? "" });
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se ha podido quitar el acceso.");
    } finally {
      setBusy(false);
      setConfirmRevoke(false);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-gray-100 text-sm">
      <p className="font-medium text-gray-700">Acceso al panel</p>
      <p className="text-xs text-gray-500">{panelAccessText(access)}</p>

      {instructions && (
        <div className="mt-2 rounded-lg bg-green-50 p-3 text-xs text-green-900 space-y-2">
          <p className="font-medium">Acceso listo. Pásale esto junto con la contraseña:</p>
          <pre className="whitespace-pre-wrap font-sans">{instructions}</pre>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-green-800 hover:underline"
            onClick={async () => {
              await navigator.clipboard.writeText(instructions);
              setCopied(true);
            }}
          >
            <Copy className="w-3 h-3" aria-hidden /> {copied ? "Copiado" : "Copiar"}
          </button>
        </div>
      )}

      {form === "grant" ? (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-gray-600">
            Entrará con <strong>{email || "el email de su ficha"}</strong>. Elige una contraseña para dársela.
          </p>
          <input
            className={input}
            type="password"
            autoComplete="new-password"
            placeholder={`Contraseña (mínimo ${MIN_PASSWORD})`}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Contraseña"
          />
          <input
            className={input}
            type="password"
            autoComplete="new-password"
            placeholder="Repite la contraseña"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-label="Repite la contraseña"
          />
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              onClick={grant}
              disabled={busy}
            >
              {status === "none" ? "Dar acceso" : "Guardar contraseña"}
            </button>
            <button type="button" className="px-3 py-1.5 border rounded-lg hover:bg-gray-50" onClick={close}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 px-3 py-1.5 border rounded-lg hover:bg-gray-50"
            onClick={() => setForm("grant")}
            disabled={busy || !email}
            title={email ? undefined : "Pon un email en la ficha primero"}
          >
            <KeyRound className="w-4 h-4" aria-hidden />
            {status === "active" ? "Nueva contraseña" : status === "revoked" ? "Devolver acceso" : "Dar acceso al panel"}
          </button>
          {status === "active" && (
            <button
              type="button"
              className="inline-flex items-center gap-1 px-3 py-1.5 border rounded-lg hover:bg-gray-50 text-red-700"
              onClick={() => setConfirmRevoke(true)}
              disabled={busy}
            >
              <UserX className="w-4 h-4" aria-hidden /> Quitar acceso
            </button>
          )}
          {error && !form && (
            <p role="alert" className="w-full text-xs text-red-600">
              {error}
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRevoke}
        title={`¿Quitar el acceso al panel a ${name}?`}
        description="No podrá entrar hasta que se lo vuelvas a dar."
        confirmLabel="Quitar acceso"
        destructive
        loading={busy}
        onCancel={() => setConfirmRevoke(false)}
        onConfirm={performRevoke}
      />
    </div>
  );
}
