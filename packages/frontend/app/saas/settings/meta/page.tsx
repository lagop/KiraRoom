"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, X } from "lucide-react";
import apiClient, { PlatformMetaStatus } from "@/lib/api";

/**
 * KiraRoom's own Meta app, for the saas_owner (channels audit, phase 2).
 *
 * Read-only: META_APP_ID, META_APP_SECRET and META_WEBHOOK_VERIFY_TOKEN
 * live in the server's environment. Without the app id and secret every
 * webhook from Meta is refused (its signature cannot be checked), so no
 * salon receives WhatsApp, Messenger or Instagram messages; the salons'
 * pages say so. This page shows which settings exist, never their values,
 * and the webhook URLs to enter in the app.
 */
export default function PlatformMetaPage() {
  const [status, setStatus] = useState<PlatformMetaStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .getPlatformMetaStatus()
      .then(setStatus)
      .catch((err: any) => setError(err?.message ?? "No se ha podido leer el estado de la app de Meta."));
  }, []);

  if (!status) {
    return error ? <p className="text-red-600">{error}</p> : <div className="text-gray-500">Cargando…</div>;
  }

  const rows: Array<{ label: string; ok: boolean; hint: string }> = [
    { label: "META_APP_ID", ok: status.appIdSet, hint: "Id de la app de Meta de KiraRoom." },
    {
      label: "META_APP_SECRET",
      ok: status.appSecretSet,
      hint: "Clave secreta de la app: con ella se comprueba la firma de cada webhook.",
    },
    {
      label: "META_WEBHOOK_VERIFY_TOKEN",
      ok: status.verifyTokenSet,
      hint: "El mismo valor que se pone en Meta al configurar el webhook (no el de ejemplo).",
    },
  ];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">App de Meta de la plataforma</h1>
        <p className="text-gray-500 mt-1">
          Recibir mensajes de WhatsApp, Messenger e Instagram. Se configura en las variables de entorno del servidor.
        </p>
      </div>

      {status.receiving ? (
        <div className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          <Check className="mt-0.5 h-4 w-4 shrink-0" />
          <p>Configurada: KiraRoom puede recibir los webhooks de Meta.</p>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Sin configurar: Meta no puede entregar mensajes a KiraRoom. Los salones pueden enviar avisos por WhatsApp, pero
            la recepcionista no contesta allí ni en Messenger o Instagram, y las respuestas «BAJA» no se registran. Sus
            páginas de ajustes lo indican.
          </p>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start gap-3 p-4">
            {r.ok ? (
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
            ) : (
              <X className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            )}
            <div>
              <div className="font-mono text-sm">{r.label}</div>
              <div className="text-xs text-gray-500">{r.ok ? "Definida." : "Falta."} {r.hint}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-2 text-sm">
        <h2 className="font-semibold text-gray-900">URL de webhook para la app</h2>
        {status.webhookUrls ? (
          <dl className="space-y-2">
            <div>
              <dt className="text-xs text-gray-500">WhatsApp (producto WhatsApp, campo «messages»)</dt>
              <dd className="break-all font-mono text-xs">{status.webhookUrls.whatsapp}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Messenger e Instagram (campos «messages» y «messaging_postbacks»)</dt>
              <dd className="break-all font-mono text-xs">{status.webhookUrls.messengerInstagram}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-xs text-amber-800">Falta API_BASE_URL: sin ella no se puede mostrar la dirección pública.</p>
        )}
      </div>
    </div>
  );
}
