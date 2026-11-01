"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, Check, Mail, Package, Save, Send } from "lucide-react";
import apiClient, { PlatformEmailConfig } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  EmailForm,
  OPEN_TRACKING_NOTE,
  PackForm,
  emailStatus,
  emailUpdate,
  packForm,
  packUpdate,
} from "@/lib/platform-email";
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
  // The bono de emails salons can buy once their month's marketing emails run out.
  const [pack, setPack] = useState<PackForm>({ emails: "", price: "" });
  const [packError, setPackError] = useState<string | null>(null);
  const [confirmPackOff, setConfirmPackOff] = useState(false);
  // The console setting about to be removed, confirmed in the panel's dialog.
  const [pendingClear, setPendingClear] = useState<{
    field: "apiKey" | "from" | "webhookSecret";
    what: string;
  } | null>(null);

  function show(next: PlatformEmailConfig) {
    setCfg(next);
    setForm({ apiKey: "", from: next.from.value ?? "", webhookSecret: "" });
    setPack(packForm(next));
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

  async function savePack() {
    const out = packUpdate(pack);
    if (!out.ok) {
      setPackError(out.error);
      return;
    }
    setPackError(null);
    await save(out.value);
  }

  async function stopPack() {
    await save({ marketingPackEmails: null, marketingPackPriceCents: null });
    setConfirmPackOff(false);
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
    setPendingClear({ field, what });
  }

  async function performClear() {
    if (!pendingClear) return;
    await save({ [pendingClear.field]: null });
    setPendingClear(null);
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
          hint={`Para registrar entregas, clics y rebotes de las campañas (las aperturas no se usan). En Resend → Webhooks, crea uno a ${WEBHOOK_URL} y copia aquí su «Signing secret».`}
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

      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>{OPEN_TRACKING_NOTE}</span>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-4">
        <div className="flex items-start gap-2">
          <Package className="w-5 h-5 mt-0.5 shrink-0 text-purple-600" />
          <div>
            <h2 className="font-semibold text-gray-900">Bono de emails de marketing</h2>
            <p className="text-sm text-gray-500">
              Pro tiene 2.000 emails de campañas al mes y Empresa 5.000 por local. Cuando un salón los gasta, sus
              campañas quedan en pausa hasta el mes siguiente, o hasta que compra este bono. Sus emails no caducan.
              Mientras no tenga precio, no se ofrece.
            </p>
            <p className="mt-1 text-sm text-gray-700">
              {cfg.marketingPack.offered
                ? `A la venta: ${cfg.marketingPack.emails} emails por ${((cfg.marketingPack.priceCents ?? 0) / 100).toFixed(2).replace(".", ",")} € + IVA.`
                : "No está a la venta."}
            </p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Emails por bono</span>
            <input
              type="text"
              inputMode="numeric"
              value={pack.emails}
              onChange={(e) => setPack({ ...pack, emails: e.target.value })}
              placeholder="1000"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Precio sin IVA (€)</span>
            <input
              type="text"
              inputMode="decimal"
              value={pack.price}
              onChange={(e) => setPack({ ...pack, price: e.target.value })}
              placeholder="15,00"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
        </div>
        {packError && <p className="text-sm text-red-600">{packError}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={savePack}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm disabled:opacity-40"
          >
            <Save className="w-4 h-4" />
            {saving ? "Guardando…" : "Guardar bono"}
          </button>
          {cfg.marketingPack.offered && (
            <button
              type="button"
              onClick={() => setConfirmPackOff(true)}
              disabled={saving}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm disabled:opacity-40"
            >
              Dejar de venderlo
            </button>
          )}
        </div>
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

      <ConfirmDialog
        open={!!pendingClear}
        title={`¿Quitar ${pendingClear?.what ?? ""} de la consola?`}
        description="Se usará la del servidor (.env), si la hay."
        confirmLabel="Quitar de la consola"
        destructive
        loading={saving}
        onCancel={() => setPendingClear(null)}
        onConfirm={performClear}
      />

      <ConfirmDialog
        open={confirmPackOff}
        title="¿Dejar de vender el bono de emails?"
        description="Los salones ya no podrán comprarlo. Los emails que ya compraron siguen siendo suyos."
        confirmLabel="Dejar de venderlo"
        destructive
        loading={saving}
        onCancel={() => setConfirmPackOff(false)}
        onConfirm={stopPack}
      />
    </div>
  );
}
