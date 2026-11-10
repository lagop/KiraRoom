"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRightLeft, Check, CreditCard, FlaskConical, PlugZap, RotateCcw, Save, Trash2 } from "lucide-react";
import apiClient, { PlatformStripeConfig, PlatformStripeTestModePlans, PlatformStripeUpdate } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  BACK_TO_SERVER,
  CONNECT_WEBHOOK_EVENTS,
  STRIPE_WEBHOOK_EVENTS,
  SWITCH_MODE,
  StripeForm,
  hasConsoleKeys,
  modeName,
  otherModeChecklist,
  previewWarning,
  stripeStatus,
  stripeUpdate,
} from "@/lib/platform-stripe";
import { SettingField as Field } from "../setting-field";

// Where Stripe sends KiraRoom's payment events; shown so it can be copied.
const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1").replace(/\/+$/, "");
const WEBHOOK_URL = `${API_BASE}/webhooks/stripe`;
// A separate endpoint in Stripe, of type "Cuentas conectadas", for the salons' own accounts.
const CONNECT_WEBHOOK_URL = `${API_BASE}/webhooks/stripe-connect`;

const TONE = {
  ok: "border-green-200 bg-green-50 text-green-800",
  test: "border-amber-200 bg-amber-50 text-amber-800",
  off: "border-red-200 bg-red-50 text-red-800",
};

const EMPTY_FORM: StripeForm = {
  secretKey: "",
  publishableKey: "",
  webhookSecret: "",
  otherWebhookSecret: "",
  otherSecretKey: "",
  otherPublishableKey: "",
  connectWebhookSecretTest: "",
  connectWebhookSecretLive: "",
};

/** "Borrar lo guardado del otro modo": the three saved fields cleared at once. */
const CLEAR_OTHER = { otherSecretKey: null, otherPublishableKey: null, otherWebhookSecret: null };

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
    setForm({ ...EMPTY_FORM, publishableKey: next.publishableKey.value ?? "", otherPublishableKey: next.other.publishableKey.value ?? "" });
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
  const otherChecklist = otherModeChecklist(cfg);
  const otherName = modeName(cfg.other.mode);
  const hasOtherSaved = otherChecklist.some((c) => c.saved);

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

      {cfg.mode !== "none" && (
        <div className="grid gap-3 sm:grid-cols-2">
          {(["test", "live"] as const).map((m) => {
            const active = cfg.mode === m;
            const saved = !active && otherChecklist.every((c) => c.saved);
            return (
              <div
                key={m}
                className={`rounded-xl border-2 p-4 ${
                  active ? (m === "live" ? "border-green-500 bg-green-50" : "border-amber-400 bg-amber-50") : "border-gray-200 bg-white"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-bold text-gray-900">{m === "live" ? "Modo real" : "Modo de pruebas"}</span>
                  <span
                    className={`text-xs font-bold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                      active ? "bg-gray-900 text-white" : saved ? "bg-gray-100 text-gray-700" : "bg-gray-100 text-gray-400"
                    }`}
                  >
                    {active ? "En uso" : saved ? "Guardado" : "Sin guardar"}
                  </span>
                </div>
                <p className="text-xs text-gray-600 mt-1">
                  {active
                    ? m === "live"
                      ? "Los salones pagan de verdad."
                      : "Los pagos son simulados."
                    : saved
                      ? `Sus tres claves están guardadas (…${cfg.other.secretKey.lastFour}).`
                      : "Faltan claves por guardar abajo."}
                </p>
                {!active && (
                  <button
                    type="button"
                    onClick={() => saveChecked(SWITCH_MODE)}
                    disabled={!cfg.other.canSwitch || saving || !!pending}
                    title={cfg.other.switchProblem ?? (pending ? "Guarda o descarta los cambios del formulario primero." : undefined)}
                    className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-sm disabled:opacity-40"
                  >
                    <ArrowRightLeft className="w-4 h-4" />
                    Pasar a modo {modeName(m)}
                  </button>
                )}
                {!active && !cfg.other.canSwitch && cfg.other.switchProblem && (
                  <p className="text-xs text-gray-500 mt-2">{cfg.other.switchProblem}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

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
        {cfg.mode !== "none" && (
          <p className="text-sm font-semibold text-gray-900">Claves en uso (modo {modeName(cfg.mode)})</p>
        )}
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
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 space-y-5">
            <div>
              <p className="text-sm font-semibold text-gray-900">Claves del modo {otherName}, guardadas sin usar</p>
              <p className="text-xs text-gray-600 mt-1">
                Guarda aquí el juego completo del otro modo para poder pasar de uno a otro con un botón, sin volver a pegar nada. No se
                usa para cobrar hasta que pulses «Pasar a modo {otherName}», y al hacerlo el juego en uso queda guardado en su lugar.
              </p>
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {otherChecklist.map((c) => (
                  <li key={c.label} className={c.saved ? "text-green-700" : "text-gray-500"}>
                    {c.saved ? "✓" : "○"} {c.label}
                  </li>
                ))}
              </ul>
            </div>

            <Field
              label={`Clave secreta de modo ${otherName}`}
              source={cfg.other.secretKey.lastFour ? "console" : "none"}
              current={cfg.other.secretKey.lastFour ? `…${cfg.other.secretKey.lastFour}` : null}
              hint={`Stripe (en modo ${otherName}) → Desarrolladores → Claves de API. Se guarda cifrada y no se vuelve a mostrar.`}
            >
              <input
                type="password"
                autoComplete="off"
                value={form.otherSecretKey}
                onChange={(e) => setForm({ ...form, otherSecretKey: e.target.value })}
                placeholder={cfg.other.secretKey.lastFour ? "Escribe una clave nueva para sustituirla" : "sk_live_… o sk_test_…"}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
              />
            </Field>

            <Field
              label={`Clave publicable de modo ${otherName}`}
              source={cfg.other.publishableKey.value ? "console" : "none"}
              current={null}
              hint="Del mismo modo que la secreta de arriba."
            >
              <input
                type="text"
                autoComplete="off"
                value={form.otherPublishableKey}
                onChange={(e) => setForm({ ...form, otherPublishableKey: e.target.value })}
                placeholder="pk_live_… o pk_test_…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
              />
            </Field>

            <Field
              label={`Secreto del webhook de modo ${otherName}`}
              source={cfg.otherWebhookSecret.source}
              current={cfg.otherWebhookSecret.lastFour ? `whsec_…${cfg.otherWebhookSecret.lastFour}` : null}
              hint={`Cada modo tiene su propio webhook en Stripe, con los mismos eventos y la misma dirección. Mientras no esté en uso, los avisos de Stripe del modo ${otherName} (reintentos, renovaciones de suscripciones antiguas) se reciben y se descartan, y nunca activan un plan.`}
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

            {(hasOtherSaved || cfg.otherWebhookSecret.source === "console" || cfg.otherWebhookSecret.source === "unreadable") && (
              <button
                type="button"
                onClick={() =>
                  setPendingSave({
                    input: CLEAR_OTHER,
                    title: `¿Borrar lo guardado del modo ${otherName}?`,
                    lines: [
                      `Se borran la clave secreta, la publicable y el secreto del webhook guardados del modo ${otherName}. No cambia el modo en uso. Los avisos que aún lleguen de ese modo fallarán hasta que borres su webhook en Stripe.`,
                    ],
                    confirmLabel: "Borrar",
                    destructive: true,
                  })
                }
                disabled={saving}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-300 text-sm text-red-700 disabled:opacity-40"
              >
                <Trash2 className="w-4 h-4" />
                Borrar lo guardado del modo {otherName}
              </button>
            )}
          </div>
        )}

        <div className="rounded-lg border border-gray-200 p-4 space-y-5">
          <div>
            <p className="text-sm font-semibold text-gray-900">Webhook de cuentas conectadas (cobros online de los salones)</p>
            <p className="text-xs text-gray-600 mt-1">
              Es otro webhook, distinto del de arriba. En Stripe → Desarrolladores → Webhooks, crea uno de tipo «Cuentas
              conectadas» a <code className="font-mono">{CONNECT_WEBHOOK_URL}</code> con los eventos{" "}
              {CONNECT_WEBHOOK_EVENTS.map((e, i) => (
                <span key={e}>
                  <code className="font-mono">{e}</code>
                  {i < CONNECT_WEBHOOK_EVENTS.length - 1 ? ", " : ""}
                </span>
              ))}
              . Cada modo (pruebas y real) tiene el suyo, con su propio secreto, y no se intercambian al cambiar de modo. Mientras
              falte, los salones pueden conectar su cuenta, pero KiraRoom no se entera de los cambios hasta que pulsen «Comprobar».
            </p>
          </div>
          <Field
            label="Secreto del webhook de cuentas conectadas · modo de pruebas"
            source={cfg.connectWebhook.test.lastFour ? "console" : "none"}
            current={cfg.connectWebhook.test.lastFour ? `whsec_…${cfg.connectWebhook.test.lastFour}` : null}
            hint="Se guarda cifrado y no se vuelve a mostrar."
          >
            <input
              type="password"
              autoComplete="off"
              value={form.connectWebhookSecretTest}
              onChange={(e) => setForm({ ...form, connectWebhookSecretTest: e.target.value })}
              placeholder={cfg.connectWebhook.test.lastFour ? "Escribe uno nuevo para sustituirlo" : "whsec_…"}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </Field>
          <Field
            label="Secreto del webhook de cuentas conectadas · modo real"
            source={cfg.connectWebhook.live.lastFour ? "console" : "none"}
            current={cfg.connectWebhook.live.lastFour ? `whsec_…${cfg.connectWebhook.live.lastFour}` : null}
            hint="Se guarda cifrado y no se vuelve a mostrar."
          >
            <input
              type="password"
              autoComplete="off"
              value={form.connectWebhookSecretLive}
              onChange={(e) => setForm({ ...form, connectWebhookSecretLive: e.target.value })}
              placeholder={cfg.connectWebhook.live.lastFour ? "Escribe uno nuevo para sustituirlo" : "whsec_…"}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </Field>
        </div>

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
          el servidor. Para pasar a modo real: crea en Stripe (modo real) el webhook con los eventos de arriba, guarda arriba, en
          «Claves del modo real», la clave secreta, la publicable y el secreto de ese webhook, y pulsa «Pasar a modo real»; antes
          de cambiar verás los salones que tienen datos del otro modo. Los avisos del modo que no está en uso nunca activan un plan.
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
