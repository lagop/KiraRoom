"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, Check, Mail, Save, Send } from "lucide-react";
import apiClient, { PlatformEmailConfig } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { EmailForm, emailStatus, emailUpdate } from "@/lib/platform-email";
import { SettingField as Field } from "../setting-field";

// Where Resend sends delivery events; shown so it can be copied into Resend.
const WEBHOOK_URL = `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1").replace(/\/+$/, "")}/webhooks/resend`;

/**
 * The platform's email (Resend), for the saas_owner: API key, sender and
 * webhook secret. The key and the secret are write-only: the page shows
 * where each comes from and its last characters, never the value.
 */
export default function PlatformEmailPage() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<PlatformEmailConfig | null>(null);
  const [form, setForm] = useState<EmailForm>({ apiKey: "", from: "", webhookSecret: "" });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function show(next: PlatformEmailConfig) {
    setCfg(next);
    setForm({ apiKey: "", from: next.from.value ?? "", webhookSecret: "" });
  }

  useEffect(() => {
    apiClient
      .getPlatformEmailConfig()
      .then(show)
      .catch((err: any) => setError(err?.message ?? "No se ha podido cargar la configuración."));
  }, []);

  async function save(input: Parameters<typeof apiClient.updatePlatformEmailConfig>[0]) {
    setSaving(true);
    setError(null);
    try {
      show(await apiClient.updatePlatformEmailConfig(input));
      setTestResult(null);
      toast({ title: "Guardado", description: "Los cambios se aplican ya, sin reiniciar nada." });
    } catch (err: any) {
      setError(err?.message ?? "No se ha podido guardar.");
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await apiClient.sendPlatformTestEmail());
    } catch (err: any) {
      setTestResult({ ok: false, message: err?.message ?? "Error" });
    } finally {
      setTesting(false);
    }
  }

  function clear(field: "apiKey" | "from" | "webhookSecret", what: string) {
    if (window.confirm(`¿Quitar ${what} de la consola? Se usará la del servidor (.env), si la hay.`)) {
      save({ [field]: null });
    }
  }

  if (!cfg) {
    return error ? <p className="text-red-600">{error}</p> : <div className="text-gray-500">Cargando…</div>;
  }

  const status = emailStatus(cfg);
  const pending = emailUpdate(form, cfg);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Email de la plataforma</h1>
        <p className="text-gray-500 mt-1">
          Los emails de KiraRoom salen por Resend: citas, avisos de la suscripción, recuperar la contraseña y campañas.
        </p>
      </div>

      <div
        className={`flex items-start gap-2 rounded-lg border p-4 text-sm ${
          status.ok ? "border-green-200 bg-green-50 text-green-800" : "border-amber-200 bg-amber-50 text-amber-800"
        }`}
      >
        {status.ok ? <Check className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
        <span>{status.text}</span>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-6">
        <Field
          label="Clave de la API de Resend"
          source={cfg.apiKey.source}
          current={cfg.apiKey.lastFour ? `re_…${cfg.apiKey.lastFour}` : null}
          hint="Resend → API Keys. Mejor una clave con permiso solo para enviar desde tu dominio. Se guarda cifrada y no se vuelve a mostrar."
          onClear={cfg.apiKey.source === "console" ? () => clear("apiKey", "la clave") : undefined}
        >
          <input
            type="password"
            autoComplete="off"
            value={form.apiKey}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            placeholder={cfg.apiKey.lastFour ? "Escribe una clave nueva para sustituirla" : "re_…"}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
          />
        </Field>

        <Field
          label="Dirección de envío"
          source={cfg.from.source}
          current={null}
          hint="Del dominio verificado en Resend. Puede llevar nombre: KiraRoom <notificaciones@kiraroom.com>. No hace falta que tenga buzón."
          onClear={cfg.from.source === "console" ? () => clear("from", "la dirección") : undefined}
        >
          <input
            type="text"
            value={form.from}
            onChange={(e) => setForm({ ...form, from: e.target.value })}
            placeholder="KiraRoom <notificaciones@kiraroom.com>"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
        </Field>

        <Field
          label="Secreto del webhook"
          source={cfg.webhookSecret.source}
          current={cfg.webhookSecret.lastFour ? `whsec_…${cfg.webhookSecret.lastFour}` : null}
          hint={`Para registrar entregas, aperturas y rebotes de las campañas. En Resend → Webhooks, crea uno a ${WEBHOOK_URL} y copia aquí su «Signing secret».`}
          onClear={cfg.webhookSecret.source === "console" ? () => clear("webhookSecret", "el secreto") : undefined}
        >
          <input
            type="password"
            autoComplete="off"
            value={form.webhookSecret}
            onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
            placeholder={cfg.webhookSecret.lastFour ? "Escribe uno nuevo para sustituirlo" : "whsec_…"}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
          />
        </Field>

        {error && (
          <p className="text-sm text-red-600 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              {error}
              {/dos pasos/.test(error) && (
                <>
                  {" "}
                  <Link href="/saas/seguridad" className="underline">
                    Ir a Seguridad
                  </Link>
                </>
              )}
            </span>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => pending && save(pending)}
            disabled={!pending || saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm disabled:opacity-40"
          >
            <Save className="w-4 h-4" />
            {saving ? "Guardando…" : "Guardar"}
          </button>
          <button
            type="button"
            onClick={sendTest}
            disabled={testing || cfg.apiKey.source === "none"}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-sm disabled:opacity-40"
          >
            <Send className="w-4 h-4" />
            {testing ? "Enviando…" : "Enviarme un email de prueba"}
          </button>
        </div>

        {testResult && (
          <p className={`text-sm ${testResult.ok ? "text-green-700" : "text-red-600"}`}>{testResult.message}</p>
        )}
      </div>

      <div className="text-sm text-gray-500 flex items-start gap-2">
        <Mail className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          Para cambiar esta configuración hace falta tener activada la verificación en dos pasos. Lo que se ponga aquí
          tiene prioridad sobre el servidor; si se quita, vuelve a usarse lo del servidor.
          {cfg.updatedAt && (
            <>
              {" "}
              Último cambio: {new Date(cfg.updatedAt).toLocaleString("es-ES")}
              {cfg.updatedBy ? `, por ${cfg.updatedBy}` : ""}.
            </>
          )}
        </span>
      </div>
    </div>
  );
}
