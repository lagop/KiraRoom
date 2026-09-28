"use client";

import { useEffect, useState } from "react";
import { Copy, Calendar, Link as LinkIcon } from "lucide-react";
import apiClient from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

type IcsTokens = Awaited<ReturnType<typeof apiClient.getIcsTokens>>;

function feedUrl(scope: string, id: string, token: string): string {
  return `${API.replace(/\/api\/v1$/, "")}/api/v1/ics/${scope}/${encodeURIComponent(id)}?token=${token}`;
}

/**
 * Subscribe URLs for the salon's calendar.
 *
 * The tokens come from GET /ics/tokens. This page used to hand out URLs
 * ending in ?token=REEMPLAZAR_CON_TOKEN -- which no feed accepts -- and to say
 * the tokens rotate on demand, which nothing implements.
 */
export default function CalendarFeedsPage() {
  const { toast } = useToast();
  const [tokens, setTokens] = useState<IcsTokens | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .getIcsTokens()
      .then(setTokens)
      .catch((err) => setError(err instanceof Error ? err.message : "Error"));
  }, []);

  const copied = () => toast({ title: "Enlace copiado" });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Calendar className="w-6 h-6 text-purple-600" /> Calendarios (.ics)
        </h1>
        <p className="text-gray-500 mt-1">
          Suscríbete a tu agenda desde Google Calendar, Apple Calendar o Outlook.
          Los enlaces son privados: quien tenga uno puede ver esas citas, así que
          no los compartas.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          No se pudieron obtener los enlaces: {error}
        </div>
      )}

      {tokens && (
        <>
          <FeedCard
            title="Salón completo"
            description="Todas las citas del salón agregadas en un solo calendario."
            url={feedUrl("salon", tokens.salon.slug, tokens.salon.token)}
            onCopy={copied}
          />

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="font-semibold mb-4">Por profesional</h2>
            <div className="space-y-2">
              {tokens.professionals.map((p) => (
                <FeedRow
                  key={p.id}
                  label={p.name}
                  url={feedUrl("professional", p.id, p.token)}
                  onCopy={copied}
                />
              ))}
              {tokens.professionals.length === 0 && (
                <div className="text-sm text-gray-500">Sin profesionales.</div>
              )}
            </div>
          </div>
        </>
      )}
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