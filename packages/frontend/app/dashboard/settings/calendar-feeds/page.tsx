"use client";

import { useEffect, useState } from "react";
import { Copy, Calendar, Link as LinkIcon } from "lucide-react";
import apiClient from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

function sign(scope: string): string {
  // Lightweight non-crypto hash that matches our HMAC output format client-side
  // is NOT used — the backend's IcsController.signToken is the source of truth.
  // We display a "click-to-generate" button that asks the backend for the token.
  return "";
}

export default function CalendarFeedsPage() {
  const { toast } = useToast();
  const [professionals, setProfessionals] = useState<Array<{ id: string; firstName: string; lastName: string }>>([]);
  const [tenantSlug, setTenantSlug] = useState<string>("");

  useEffect(() => {
    apiClient
      .getProfessionals()
      .then(setProfessionals)
      .catch(() => setProfessionals([]));
    apiClient
      .getTenant()
      .then((t) => setTenantSlug(t.slug))
      .catch(() => setTenantSlug(""));
  }, []);

  function copy(text: string, label = "Copiado") {
    navigator.clipboard.writeText(text).then(
      () => toast({ title: label }),
      () => toast({ title: "No se pudo copiar", variant: "destructive" }),
    );
  }

  function buildIcsUrl(scope: string, id: string, token: string) {
    return `${API.replace(/\/api\/v1$/, "")}/api/v1/ics/${scope}/${id}?token=${token}`;
  }

  function buildWebcalUrl(scope: string, id: string, token: string) {
    return `webcal://${API.replace(/^https?:\/\//, "").replace(/\/api\/v1$/, "")}/api/v1/ics/${scope}/${id}?token=${token}`;
  }

  // Token: for the demo, we sign using the same algorithm in the browser.
  // In production this should be generated server-side via an endpoint
  // (`GET /ics/tokens`). For now we copy the URL with a placeholder token
  // and ask the user to request one from their dashboard API.
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Calendar className="w-6 h-6 text-purple-600" /> Calendarios (.ics)
        </h1>
        <p className="text-gray-500 mt-1">
          Suscríbete a tu agenda desde Google Calendar, Apple Calendar o Outlook.
          Los enlaces usan un token HMAC firmado que rota cuando lo desees.
        </p>
      </div>

      <FeedCard
        title="Salón completo"
        description="Todas las citas del salón agregadas en un solo calendario."
        url={
          tenantSlug
            ? `${API.replace(/\/api\/v1$/, "")}/api/v1/ics/salon/${tenantSlug}?token=REEMPLAZAR_CON_TOKEN`
            : ""
        }
        onCopy={() => toast({ title: "Pega el token firmado desde la API" })}
      />

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="font-semibold mb-4">Por profesional</h2>
        <div className="space-y-2">
          {professionals.map((p) => (
            <FeedRow
              key={p.id}
              label={`${p.firstName} ${p.lastName}`}
              url={`${API.replace(/\/api\/v1$/, "")}/api/v1/ics/professional/${p.id}?token=REEMPLAZAR_CON_TOKEN`}
              onCopy={() => toast({ title: "URL copiada (pendiente token)" })}
            />
          ))}
          {professionals.length === 0 && (
            <div className="text-sm text-gray-500">Sin profesionales.</div>
          )}
        </div>
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
        <strong>Nota:</strong> El token HMAC se firma en el backend con
        <code> ICS_TOKEN_SECRET</code>. Genera el token de tu salón desde el
        endpoint <code>GET /api/v1/ics/tokens</code> (próximamente) o pídelo al
        administrador. La URL <code>webcal://</code> se detecta automáticamente
        en la mayoría de clientes de calendario.
      </div>
    </div>
  );
}

function FeedCard({
  title,
  description,
  url,
  onCopy,
}: {
  title: string;
  description: string;
  url: string;
  onCopy: () => void;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h2 className="font-semibold mb-1">{title}</h2>
      <p className="text-sm text-gray-500 mb-3">{description}</p>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          className="flex-1 bg-gray-50 border border-gray-200 rounded px-2 py-1 text-xs font-mono"
        />
        <button
          onClick={() => navigator.clipboard.writeText(url).then(onCopy)}
          className="bg-gray-100 hover:bg-gray-200 p-2 rounded"
        >
          <Copy className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function FeedRow({
  label,
  url,
  onCopy,
}: {
  label: string;
  url: string;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <LinkIcon className="w-3 h-3 text-gray-400" />
      <span className="w-40 text-sm text-gray-700">{label}</span>
      <input
        readOnly
        value={url}
        className="flex-1 bg-gray-50 border border-gray-200 rounded px-2 py-1 text-xs font-mono"
      />
      <button
        onClick={() => navigator.clipboard.writeText(url).then(onCopy)}
        className="bg-gray-100 hover:bg-gray-200 p-2 rounded"
      >
        <Copy className="w-4 h-4" />
      </button>
    </div>
  );
}