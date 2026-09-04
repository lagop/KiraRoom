"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  Check,
  Copy,
  Loader2,
  Mail,
} from "lucide-react";
import apiClient from "@/lib/api";

const PLANS = [
  { id: "esencial", label: "Esencial · 29 €/mes" },
  { id: "pro", label: "Pro · 59 €/mes" },
  { id: "empresa", label: "Empresa · 119 €/mes" },
];

export default function InviteTenantPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [plan, setPlan] = useState("esencial");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [magicLink, setMagicLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMagicLink(null);
    setLoading(true);
    try {
      const res = await apiClient.createTenantInvite({
        email: email.trim(),
        tenantName: tenantName.trim(),
        plan,
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
      });
      setMagicLink(res.magicLink);
    } catch (e: any) {
      const msg =
        e?.response?.data?.message || e?.message || "No se pudo enviar la invitación.";
      setError(typeof msg === "string" ? msg : JSON.stringify(msg));
    } finally {
      setLoading(false);
    }
  }

  async function copyLink() {
    if (!magicLink) return;
    try {
      await navigator.clipboard.writeText(magicLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — user can copy from the visible input */
    }
  }

  return (
    <div className="p-6 max-w-2xl">
      <Link
        href="/saas/tenants"
        className="inline-flex items-center text-sm text-slate-600 hover:text-slate-900 mb-4"
      >
        <ArrowLeft className="w-4 h-4 mr-1" /> Volver a Tenants
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-3 mb-6">
        <Building2 className="w-6 h-6 text-indigo-600" />
        <h1 className="text-2xl font-bold truncate">Invitar a un nuevo salón</h1>
      </div>

      <p className="text-sm text-slate-600 mb-6">
        El propietario recibirá un email con un enlace válido durante 7
        días. Al hacer clic completará un wizard de 3 pasos (contraseña,
        dirección del salón, zona horaria) y la cuenta + tenant se
        crearán automáticamente con 14 días de prueba del plan Pro.
      </p>

      <form onSubmit={submit} className="space-y-4 bg-white rounded-lg border border-slate-200 p-6">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Nombre del salón
          </label>
          <input
            type="text"
            value={tenantName}
            onChange={(e) => setTenantName(e.target.value)}
            required
            minLength={2}
            maxLength={120}
            placeholder="Glamour Studio"
            className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Email del propietario
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="dueno@glamour-studio.com"
            className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Nombre (opcional)
            </label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              maxLength={80}
              placeholder="María"
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Apellidos (opcional)
            </label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              maxLength={80}
              placeholder="García"
              className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            Plan (después de la prueba gratuita)
          </label>
          <select
            value={plan}
            onChange={(e) => setPlan(e.target.value)}
            className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            {PLANS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1">
            Independientemente del plan, los primeros 14 días son de
            prueba con acceso Pro completo.
          </p>
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded text-red-800 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => router.push("/saas/tenants")}
            className="px-4 py-2 text-sm border border-slate-300 rounded-md hover:bg-slate-50"
            disabled={loading}
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Mail className="w-4 h-4" />
            )}
            Enviar invitación
          </button>
        </div>
      </form>

      {magicLink && (
        <div className="mt-6 p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <Check className="w-5 h-5 text-emerald-600" />
            <h3 className="font-semibold text-emerald-900">
              Invitación enviada
            </h3>
          </div>
          <p className="text-sm text-emerald-800 mb-3">
            Hemos enviado el email a <strong>{email}</strong>. Si el
            correo no llega en 5 minutos, puedes compartir el enlace
            manualmente:
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={magicLink}
              className="flex-1 px-3 py-2 text-xs font-mono bg-white border border-emerald-300 rounded"
            />
            <button
              type="button"
              onClick={copyLink}
              className="inline-flex items-center gap-1 px-3 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700"
            >
              <Copy className="w-4 h-4" />
              {copied ? "Copiado" : "Copiar"}
            </button>
          </div>
          <p className="text-xs text-emerald-700 mt-2">
            El enlace caduca en 7 días y solo puede usarse una vez.
          </p>
        </div>
      )}
    </div>
  );
}