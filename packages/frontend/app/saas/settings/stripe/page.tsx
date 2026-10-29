"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, Check, CreditCard, FlaskConical, PlugZap, Save } from "lucide-react";
import apiClient, { PlatformStripeConfig } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { STRIPE_WEBHOOK_EVENTS, StripeForm, stripeStatus, stripeUpdate } from "@/lib/platform-stripe";
import { SettingField as Field } from "../setting-field";

// Where Stripe sends KiraRoom's payment events; shown so it can be copied.
const WEBHOOK_URL = `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1").replace(/\/+$/, "")}/webhooks/stripe`;

const TONE = {
  ok: "border-green-200 bg-green-50 text-green-800",
  test: "border-amber-200 bg-amber-50 text-amber-800",
  off: "border-red-200 bg-red-50 text-red-800",
};

/**
 * KiraRoom's own Stripe account (it bills the salons), for the saas_owner.
 * The secret key and the webhook secret are write-only: the page shows where
 * each comes from and its last characters, never the value.
 */
export default function PlatformStripePage() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<PlatformStripeConfig | null>(null);
  const [form, setForm] = useState<StripeForm>({ secretKey: "", publishableKey: "", webhookSecret: "", taxEnabled: false });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function show(next: PlatformStripeConfig) {
    setCfg(next);
    setForm({ secretKey: "", publishableKey: next.publishableKey.value ?? "", webhookSecret: "", taxEnabled: next.taxEnabled.value });
  }

  useEffect(() => {
    apiClient
      .getPlatformStripeConfig()
      .then(show)
      .catch((err: any) => setError(err?.message ?? "No se ha podido cargar la configuración."));
  }, []);

  async function save(input: Parameters<typeof apiClient.updatePlatformStripeConfig>[0]) {
    setSaving(true);
    setError(null);
    try {
      show(await apiClient.updatePlatformStripeConfig(input));
      setTestResult(null);
      toast({ title: "Guardado", description: "Los cambios se aplican ya, sin reiniciar nada." });
    } catch (err: any) {
      setError(err?.message ?? "No se ha podido guardar.");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await apiClient.testPlatformStripe());
    } catch (err: any) {
      setTestResult({ ok: false, message: err?.message ?? "Error" });
    } finally {
      setTesting(false);
    }
  }

  function clear(field: "secretKey" | "publishableKey" | "webhookSecret" | "taxEnabled", what: string) {
    if (window.confirm(`¿Quitar ${what} de la consola? Se usará lo del servidor (.env), si lo hay.`)) {
      save({ [field]: null });
    }
  }

  if (!cfg) {
    return error ? <p className="text-red-600">{error}</p> : <div className="text-gray-500">Cargando…</div>;
  }

  const status = stripeStatus(cfg);
  const pending = stripeUpdate(form, cfg);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Stripe de la plataforma</h1>
        <p className="text-gray-500 mt-1">
          La cuenta de Stripe de KiraRoom, con la que pagan los salones su plan, los complementos y los paquetes de mensajes.
          Las cuentas de Stripe de cada salón, para cobrar a sus clientas, se configuran aparte en su panel.
        </p>
      </div>

      <div className={`flex items-start gap-2 rounded-lg border p-4 text-sm ${TONE[status.tone]}`}>
        {status.tone === "ok" ? (
          <Check className="w-4 h-4 mt-0.5 shrink-0" />
        ) : status.tone === "test" ? (
          <FlaskConical className="w-4 h-4 mt-0.5 shrink-0" />
        ) : (
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        )}
        <span>{status.text}</span>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-6">
        <Field
          label="Clave secreta"
          source={cfg.secretKey.source}
          current={cfg.secretKey.lastFour ? `…${cfg.secretKey.lastFour}` : null}
          hint="Stripe → Desarrolladores → Claves de API. «sk_test_…» para pruebas, «sk_live_…» para cobrar de verdad. Se guarda cifrada y no se vuelve a mostrar."
          onClear={cfg.secretKey.source === "console" ? () => clear("secretKey", "la clave secreta") : undefined}
        >
          <input
            type="password"
            autoComplete="off"
            value={form.secretKey}
            onChange={(e) => setForm({ ...form, secretKey: e.target.value })}
            placeholder={cfg.secretKey.lastFour ? "Escribe una clave nueva para sustituirla" : "sk_test_… o sk_live_…"}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
          />
        </Field>

        <Field
          label="Clave publicable"
          source={cfg.publishableKey.source}
          current={null}
          hint="En la misma página que la secreta: «pk_test_…» o «pk_live_…», del mismo modo que la secreta."
          onClear={cfg.publishableKey.source === "console" ? () => clear("publishableKey", "la clave publicable") : undefined}
        >
          <input
            type="text"
            autoComplete="off"
            value={form.publishableKey}
            onChange={(e) => setForm({ ...form, publishableKey: e.target.value })}
            placeholder="pk_test_… o pk_live_…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
          />
        </Field>

        <Field
          label="Secreto del webhook"
          source={cfg.webhookSecret.source}
          current={cfg.webhookSecret.lastFour ? `whsec_…${cfg.webhookSecret.lastFour}` : null}
          hint={
            <>
              Obligatorio con la clave secreta. En Stripe → Desarrolladores → Webhooks, crea uno de «tu cuenta» a{" "}
              <code className="font-mono">{WEBHOOK_URL}</code> con estos eventos:{" "}
              {STRIPE_WEBHOOK_EVENTS.map((e, i) => (
                <span key={e}>
                  <code className="font-mono">{e}</code>
                  {i < STRIPE_WEBHOOK_EVENTS.length - 1 ? ", " : ""}
                </span>
              ))}
              . Copia aquí su «Signing secret». En modo real hace falta otro webhook, con su propio secreto.
            </>
          }
          onClear={cfg.webhookSecret.source === "console" ? () => clear("webhookSecret", "el secreto del webhook") : undefined}
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

        <Field
          label="IVA con Stripe Tax"
          source={cfg.taxEnabled.source}
          current={null}
          hint="Stripe calcula el IVA de cada pago y pide el NIF del salón para su factura. Actívalo solo después de configurar Stripe Tax en Stripe (Ajustes → Impuestos: dirección de origen y registro de IVA en España); si no, los pagos fallarán."
          onClear={cfg.taxEnabled.source === "console" ? () => clear("taxEnabled", "el ajuste del IVA") : undefined}
        >
          <label className="inline-flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={form.taxEnabled}
              onChange={(e) => setForm({ ...form, taxEnabled: e.target.checked })}
              className="h-4 w-4"
            />
            Cobrar el IVA con Stripe Tax
          </label>
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
            onClick={testConnection}
            disabled={testing || cfg.mode === "none"}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-sm disabled:opacity-40"
          >
            <PlugZap className="w-4 h-4" />
            {testing ? "Comprobando…" : "Comprobar la conexión"}
          </button>
        </div>

        {testResult && (
          <p className={`text-sm ${testResult.ok ? "text-green-700" : "text-red-600"}`}>{testResult.message}</p>
        )}
      </div>

      <div className="text-sm text-gray-500 flex items-start gap-2">
        <CreditCard className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          Para cambiar esta configuración hace falta la verificación en dos pasos. Lo que se ponga aquí tiene prioridad sobre
          el servidor; si se quita, vuelve a usarse lo del servidor. KiraRoom no acepta la clave secreta sin el secreto del
          webhook, ni claves de modos distintos.
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
