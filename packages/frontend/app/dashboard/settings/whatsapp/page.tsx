"use client";

import { useEffect, useState } from "react";
import {
  Link as LinkIcon,
  Unlink,
  RefreshCw,
  ExternalLink,
  AlertCircle,
  Check,
} from "lucide-react";
import apiClient, { WhatsAppConnection } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

export default function WhatsAppSettingsPage() {
  const { toast } = useToast();
  const [conn, setConn] = useState<WhatsAppConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [manual, setManual] = useState({
    accessToken: "",
    wabaId: "",
    phoneNumberId: "",
    displayPhone: "",
    displayName: "",
  });
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setConn(await apiClient.getWhatsAppConnection());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function startOAuth() {
    try {
      const { url } = await apiClient.startWhatsAppConnect();
      window.open(url, "_blank", "noopener");
    } catch (err: any) {
      toast({ title: err?.message ?? "Error", variant: "destructive" });
    }
  }

  async function connectManual() {
    setBusy(true);
    try {
      await apiClient.manualWhatsAppConnect(manual);
      toast({ title: "Conexión registrada" });
      setManual({
        accessToken: "",
        wabaId: "",
        phoneNumberId: "",
        displayPhone: "",
        displayName: "",
      });
      await load();
    } catch (err: any) {
      toast({ title: err?.message ?? "Error", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!confirm("¿Desconectar WhatsApp? Las campañas pendientes no se enviarán.")) return;
    try {
      await apiClient.disconnectWhatsApp();
      toast({ title: "Desconectado" });
      await load();
    } catch (err: any) {
      toast({ title: err?.message ?? "Error", variant: "destructive" });
    }
  }

  if (loading) return <div className="text-gray-500">Cargando…</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">WhatsApp Business</h1>
        <p className="text-gray-500 mt-1">
          Conecta tu WABA para enviar campañas masivas. Cada tenant trae su
          propio número (cumplimiento Meta).
        </p>
      </div>

      {conn ? (
        <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold flex items-center gap-2">
                <Check className="w-4 h-4 text-green-600" /> Conectado
              </div>
              <div className="text-sm text-gray-500 mt-1">
                {conn.displayName || conn.displayPhone}
              </div>
            </div>
            <span
              className={`text-xs px-2 py-1 rounded ${
                conn.qualityScore === "GREEN"
                  ? "bg-green-100 text-green-700"
                  : conn.qualityScore === "YELLOW"
                    ? "bg-yellow-100 text-yellow-700"
                    : conn.qualityScore === "RED"
                      ? "bg-red-100 text-red-700"
                      : "bg-gray-100 text-gray-600"
              }`}
            >
              Quality: {conn.qualityScore || "—"}
            </span>
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="text-gray-500">WABA ID</dt>
              <dd className="font-mono">{conn.wabaId}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Phone Number ID</dt>
              <dd className="font-mono">{conn.phoneNumberId}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Display Phone</dt>
              <dd className="font-mono">{conn.displayPhone}</dd>
            </div>
            {conn.tokenExpiresAt && (
              <div>
                <dt className="text-gray-500">Token expira</dt>
                <dd>{new Date(conn.tokenExpiresAt).toLocaleString()}</dd>
              </div>
            )}
          </dl>
          <button
            onClick={disconnect}
            className="text-red-600 hover:bg-red-50 px-3 py-1.5 rounded inline-flex items-center gap-2 text-sm"
          >
            <Unlink className="w-4 h-4" /> Desconectar
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="font-semibold mb-2">Opción 1 — OAuth Meta</h2>
            <p className="text-sm text-gray-500 mb-3">
              Te redirigiremos a Meta Business Manager para autorizar.
              Necesitas una app de Meta configurada con{" "}
              <code>whatsapp_business_management</code> y{" "}
              <code>whatsapp_business_messaging</code>.
            </p>
            <button
              onClick={startOAuth}
              className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 inline-flex items-center gap-2"
            >
              <ExternalLink className="w-4 h-4" /> Conectar con Meta
            </button>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="font-semibold mb-2">Opción 2 — Conexión manual</h2>
            <p className="text-sm text-gray-500 mb-3">
              Pega los datos de tu WABA desde Meta Business Manager. Útil en
              sandbox / dev.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input label="Access Token" value={manual.accessToken} onChange={(v) => setManual({ ...manual, accessToken: v })} />
              <Input label="WABA ID" value={manual.wabaId} onChange={(v) => setManual({ ...manual, wabaId: v })} />
              <Input label="Phone Number ID" value={manual.phoneNumberId} onChange={(v) => setManual({ ...manual, phoneNumberId: v })} />
              <Input label="Display Phone (E.164)" value={manual.displayPhone} onChange={(v) => setManual({ ...manual, displayPhone: v })} />
              <Input label="Display Name (opcional)" value={manual.displayName} onChange={(v) => setManual({ ...manual, displayName: v })} />
            </div>
            <div className="flex justify-end pt-3">
              <button
                onClick={connectManual}
                disabled={busy}
                className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                <LinkIcon className="w-4 h-4" /> {busy ? "Conectando…" : "Conectar"}
              </button>
            </div>
          </div>

          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5" />
            <div>
              El access token se cifra en reposo con AES-256-GCM (clave en{" "}
              <code>META_TOKEN_ENCRYPTION_KEY</code>) y nunca se expone por API.
              Solo el dispatcher interno descifra para llamar a Meta.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
      />
    </div>
  );
}