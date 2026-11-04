"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, Check, CreditCard, FlaskConical, PlugZap, RotateCcw, Save } from "lucide-react";
import apiClient, { PlatformStripeConfig, PlatformStripeTestModePlans, PlatformStripeUpdate } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  BACK_TO_SERVER,
  STRIPE_WEBHOOK_EVENTS,
  StripeForm,
  hasConsoleKeys,
  modeName,
  previewWarning,
  stripeStatus,
  stripeUpdate,
} from "@/lib/platform-stripe";
import { SettingField as Field } from "../setting-field";

// Where Stripe sends KiraRoom's payment events; shown so it can be copied.
const WEBHOOK_URL = `${(process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1").replace(/\/+$/, "")}/webhooks/stripe`;

const TONE = {
  ok: "border-green-200 bg-green-50 text-green-800",
  test: "border-amber-200 bg-amber-50 text-amber-800",
  off: "border-red-200 bg-red-50 text-red-800",
};

const EMPTY_FORM: StripeForm = { secretKey: "", publishableKey: "", webhookSecret: "", otherWebhookSecret: "" };

/** A save waiting for the admin to confirm what it does. */
interface PendingSave {
  input: PlatformStripeUpdate;
  title: string;
  lines: string[];
  confirmLabel: string;
  destructive: boolean;
}

/**
 * KiraRoom's own Stripe account (it bills the salons), for the saas_owner.
 * The secret key and the webhook secrets are write-only: the page shows where
 * each comes from and its last characters, never the value. The secret key
 * and its webhook secret always come from the same place (console or .env);
 * a change of mode is confirmed with the salons it affects.
 */
export default function PlatformStripePage() {
  const { toast } = useToast();
  const [cfg, setCfg] = useState<PlatformStripeConfig | null>(null);
  const [form, setForm] = useState<StripeForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<PendingSave | null>(null);
  const [testPlans, setTestPlans] = useState<PlatformStripeTestModePlans | null>(null);

  function loadTestPlans() {
    apiClient
      .getPlatformStripeTestModePlans()
      .then(setTestPlans)
      .catch(() => setTestPlans(null));
  }

  function show(next: PlatformStripeConfig) {
    setCfg(next);
    setForm({ ...EMPTY_FORM, publishableKey: next.publishableKey.value ?? "" });
  }

  useEffect(() => {
    apiClient
      .getPlatformStripeConfig()
      .then(show)
      .catch((err: any) => setError(err?.message ?? "No se ha podido cargar la configuración."));
    loadTestPlans();
  }, []);

  async function save(input: PlatformStripeUpdate) {
    setSaving(true);
    setError(null);
    try {
      show(await apiClient.updatePlatformStripeConfig(input));
      setTestResult(null);
      setPendingSave(null);
      loadTestPlans();
      toast({ title: "Guardado", description: "Los cambios se aplican ya, sin reiniciar nada." });
    } catch (err: any) {
      setPendingSave(null);
      setError(err?.message ?? "No se ha podido guardar.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Asks the server what saving would do first: refused (shown as the
   * error), a change of mode (confirmed with the salons it affects), or
   * nothing to confirm (saved at once).
   */
  async function saveChecked(input: PlatformStripeUpdate, always?: { title: string; confirmLabel: string }) {
    setSaving(true);
    setError(null);
    try {
      const preview = await apiClient.previewPlatformStripeConfig(input);
      if (preview.problem) {
        setError(preview.problem);
        return;
      }
      const warning = previewWarning(preview);
      if (warning) {
        setPendingSave({ input, ...warning, confirmLabel: `Sí, pasar a modo ${modeName(preview.modeAfter)}` });
      } else if (always) {
        setPendingSave({
          input,
          title: always.title,
          lines: [`Seguirás en modo ${modeName(preview.modeAfter)}: el servidor (.env) tiene claves del mismo modo.`],
          confirmLabel: always.confirmLabel,
          destructive: false,
        });
      } else {
        setSaving(false);
        await save(input);
        return;
      }
    } catch (err: any) {
      setError(err?.message ?? "No se ha podido comprobar el cambio.");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      // The typed key if there is one (not saved), else the one in force.
      setTestResult(await apiClient.testPlatformStripe(form.secretKey.trim() || undefined));
    } catch (err: any) {
      setTestResult({ ok: false, message: err?.message ?? "Error" });
    } finally {
      setTesting(false);
    }
  }

  if (!cfg) {
    return error ? <p className="text-red-600">{error}</p> : <div className="text-gray-500">Cargando…</div>;
  }

  const status = stripeStatus(cfg);
  const pending = stripeUpdate(form, cfg);
  const otherMode = modeName(cfg.otherWebhookSecret.mode);

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

      {testPlans && (testPlans.total > 0 || cfg.mode === "test") && (
        <div
          className={`rounded-lg border p-4 text-sm ${
            testPlans.total > 0 ? "border-amber-200 bg-amber-50 text-amber-900" : "border-gray-200 bg-white text-gray-700"
          }`}
        >
          {cfg.mode === "test" && (
            <p className="mb-1">
              En modo de pruebas los salones ven «Pagos en modo de pruebas: no se cobra nada» en Facturación, y solo los
              salones internos pueden contratar un plan, cambiarlo o comprar complementos y bonos.
            </p>
          )}
          {testPlans.total === 0 ? (
            <p>Ningún salón real tiene un plan activado con un pago de prueba.</p>
          ) : (
            <>
              <p className="font-semibold">
                {testPlans.total === 1
                  ? "1 salón real tiene el plan activado con un pago de prueba (no se le ha cobrado nada):"
                  : `${testPlans.total} salones reales tienen el plan activado con un pago de prueba (no se les ha cobrado nada):`}
              </p>
              <ul className="mt-2 space-y-1">
                {testPlans.salons.map((s) => (
                  <li key={s.id}>
                    <Link href={`/saas/tenants/${s.id}`} className="underline">
                      {s.name}
                    </Link>
                    {s.slug ? ` (/${s.slug})` : ""} · {s.plan ?? "sin plan"} · {s.subscriptionStatus ?? "?"}
                  </li>
                ))}
              </ul>
              {testPlans.total > testPlans.salons.length && (
                <p className="mt-1 text-xs">Se muestran los {testPlans.salons.length} primeros.</p>
              )}
            </>
          )}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-6">
        <Field
          label="Clave secreta"
          source={cfg.secretKey.source}
          current={cfg.secretKey.lastFour ? `…${cfg.secretKey.lastFour}` : null}
          hint="Stripe → Desarrolladores → Claves de API. «sk_test_…» para pruebas, «sk_live_…» para cobrar de verdad. Se guarda cifrada y no se vuelve a mostrar."
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
              Obligatorio con la clave secreta, y del mismo sitio que ella (las dos aquí, o las dos en el servidor). En Stripe →
              Desarrolladores → Webhooks, crea uno de «tu cuenta» a <code className="font-mono">{WEBHOOK_URL}</code> con estos
              eventos:{" "}
              {STRIPE_WEBHOOK_EVENTS.map((e, i) => (
                <span key={e}>
                  <code className="font-mono">{e}</code>
                  {i < STRIPE_WEBHOOK_EVENTS.length - 1 ? ", " : ""}
                </span>
              ))}
              . Copia aquí su «Signing secret». Cada modo (pruebas y real) tiene su propio webhook y su propio secreto.
            </>
          }
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

        {cfg.mode !== "none" && (
          <Field
            label={`Secreto del webhook de modo ${otherMode} (opcional)`}
            source={cfg.otherWebhookSecret.source}
            current={cfg.otherWebhookSecret.lastFour ? `whsec_…${cfg.otherWebhookSecret.lastFour}` : null}
            hint={`Con él, los avisos de Stripe del modo ${otherMode} (reintentos tras cambiar de modo, renovaciones de suscripciones antiguas) se reciben y se descartan, en vez de fallar hasta que Stripe desactive el webhook. Nunca activan un plan. Al cambiar de modo, el secreto anterior pasa aquí solo.`}
            onClear={
              cfg.otherWebhookSecret.source === "console" || cfg.otherWebhookSecret.source === "unreadable"
                ? () =>
                    setPendingSave({
                      input: { otherWebhookSecret: null },
                      title: `¿Quitar el secreto del webhook de modo ${otherMode}?`,
                      lines: [`Los avisos que aún lleguen del modo ${otherMode} fallarán. Quítalo cuando hayas borrado ese webhook en Stripe.`],
                      confirmLabel: "Quitar",
                      destructive: true,
                    })
                : undefined
            }
          >
            <input
              type="password"
              autoComplete="off"
              value={form.otherWebhookSecret}
              onChange={(e) => setForm({ ...form, otherWebhookSecret: e.target.value })}
              placeholder="whsec_…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </Field>
        )}

        <div className="text-xs text-gray-500">
          IVA: KiraRoom no cobra IVA ni IGIC en sus planes, así que Stripe Tax está siempre desactivado y el precio que ve el
          salón es el final.
          {cfg.taxIgnored && (
            <span className="block mt-1 text-amber-700">
              El servidor tiene STRIPE_TAX_ENABLED activado (o se activó antes aquí): se ignora.
            </span>
          )}
        </div>

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
            onClick={() => pending && saveChecked(pending)}
            disabled={!pending || saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm disabled:opacity-40"
          >
            <Save className="w-4 h-4" />
            {saving ? "Guardando…" : "Guardar"}
          </button>
          <button
            type="button"
            onClick={testConnection}
            disabled={testing || (cfg.mode === "none" && !form.secretKey.trim())}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-sm disabled:opacity-40"
          >
            <PlugZap className="w-4 h-4" />
            {testing ? "Comprobando…" : form.secretKey.trim() ? "Probar la clave escrita" : "Comprobar la conexión"}
          </button>
          {hasConsoleKeys(cfg) && (
            <button
              type="button"
              onClick={() =>
                saveChecked(BACK_TO_SERVER, {
                  title: "¿Volver a lo del servidor (.env)?",
                  confirmLabel: "Volver a lo del servidor",
                })
              }
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 text-sm disabled:opacity-40"
            >
              <RotateCcw className="w-4 h-4" />
              Volver a lo del servidor (.env)
            </button>
          )}
        </div>
        {hasConsoleKeys(cfg) && (
          <p className="text-xs text-gray-500">
            «Volver a lo del servidor» quita de aquí a la vez la clave secreta, la publicable y el secreto del webhook. El servidor
            tiene {cfg.server.mode === "none" ? "ninguna clave secreta" : `claves de modo ${modeName(cfg.server.mode)}`}
            {cfg.server.mode !== "none" && !cfg.server.hasWebhookSecret ? " pero no el secreto del webhook" : ""}.
          </p>
        )}

        {testResult && (
          <p className={`text-sm ${testResult.ok ? "text-green-700" : "text-red-600"}`}>{testResult.message}</p>
        )}
      </div>

      <div className="text-sm text-gray-500 flex items-start gap-2">
        <CreditCard className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          Para cambiar esta configuración hace falta la verificación en dos pasos. Lo que se ponga aquí tiene prioridad sobre
          el servidor. Para pasar a modo real: crea en Stripe (modo real) el webhook con los eventos de arriba, pega aquí a la vez
          la clave secreta, la publicable y el secreto de ese webhook, y guarda; antes de guardar verás los salones que tienen
          datos del modo de pruebas. Los avisos del modo que no está en uso nunca activan un plan.
          {cfg.updatedAt && (
            <>
              {" "}
              Último cambio: {new Date(cfg.updatedAt).toLocaleString("es-ES")}
              {cfg.updatedBy ? `, por ${cfg.updatedBy}` : ""}.
            </>
          )}
        </span>
      </div>

      <ConfirmDialog
        open={!!pendingSave}
        title={pendingSave?.title ?? ""}
        description={
          <div className="space-y-2">
            {pendingSave?.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        }
        confirmLabel={pendingSave?.confirmLabel ?? "Confirmar"}
        destructive={pendingSave?.destructive ?? false}
        loading={saving}
        onCancel={() => setPendingSave(null)}
        onConfirm={() => pendingSave && save(pendingSave.input)}
      />
    </div>
  );
}
