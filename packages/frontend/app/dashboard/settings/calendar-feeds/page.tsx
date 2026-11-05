"use client";

import { useEffect, useState } from "react";
import { Copy, Calendar, Link as LinkIcon, RefreshCw } from "lucide-react";
import apiClient, { type IcsFeedTokens } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/src/components/ui/ConfirmDialog";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

type IcsTokens = IcsFeedTokens;

function feedUrl(scope: string, id: string, token: string): string {
  return `${API.replace(/\/api\/v1$/, "")}/api/v1/ics/${scope}/${encodeURIComponent(id)}?token=${token}`;
}

/**
 * Subscribe URLs for the salon's calendar.
 *
 * The tokens come from GET /ics/tokens. This page used to hand out URLs
 * ending in ?token=REEMPLAZAR_CON_TOKEN -- which no feed accepts. "Regenerar
 * enlaces" (POST /ics/tokens/rotate) revokes every link handed out so far.
 */
export default function CalendarFeedsPage() {
  const { toast } = useToast();
  const [tokens, setTokens] = useState<IcsTokens | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);

  const rotate = async () => {
    setRotating(true);
    try {
      setTokens(await apiClient.rotateIcsTokens());
      setConfirmRotate(false);
      toast({
        title: "Enlaces regenerados",
        description: "Los enlaces anteriores ya no funcionan. Vuelve a suscribir tus calendarios.",
      });
    } catch (err) {
      toast({
        title: "No se pudieron regenerar los enlaces",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setRotating(false);
    }
  };

  useEffect(() => {
    apiClient
      .getIcsTokens()
      .then(setTokens)
      .catch((err) => setError(err instanceof Error ? err.message : "Error"));
  }, []);

  // The clipboard API needs a secure context and permission: say so when it fails.
  const copy = (url: string) =>
    navigator.clipboard
      .writeText(url)
      .then(() => toast({ title: "Enlace copiado" }))
      .catch(() =>
        toast({
          title: "No se pudo copiar el enlace",
          description: "Selecciónalo en el recuadro y cópialo a mano.",
          variant: "destructive",
        }),
      );

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
        <p className="text-gray-500 mt-1 text-sm">
          Cada cita muestra solo el servicio y el nombre de pila de la clienta: ni
          apellidos, ni teléfono, ni email, ni notas.
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
            onCopy={copy}
          />

          <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
            <h2 className="font-semibold mb-4">Por profesional</h2>
            <div className="space-y-2">
              {tokens.professionals.map((p) => (
                <FeedRow
                  key={p.id}
                  label={p.name}
                  url={feedUrl("professional", p.id, p.token)}
                  onCopy={copy}
                />
              ))}
              {tokens.professionals.length === 0 && (
                <div className="text-sm text-gray-500">Sin profesionales.</div>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-1">
              <h2 className="font-semibold mb-1">¿Se ha filtrado un enlace?</h2>
              <p className="text-sm text-gray-500">
                Regenera los enlaces para que los anteriores dejen de funcionar.
                {tokens.rotatedAt && (
                  <> Última regeneración: {new Date(tokens.rotatedAt).toLocaleString("es-ES")}.</>
                )}
              </p>
            </div>
            <button
              onClick={() => setConfirmRotate(true)}
              className="inline-flex items-center gap-2 border border-red-200 text-red-700 hover:bg-red-50 rounded-lg px-3 py-2 text-sm font-medium"
            >
              <RefreshCw className="w-4 h-4" /> Regenerar enlaces
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmRotate}
        title="¿Regenerar todos los enlaces?"
        description="Todos los calendarios suscritos (el del salón y los de cada profesional) dejarán de actualizarse hasta que se suscriban de nuevo con los enlaces nuevos."
        confirmLabel="Regenerar"
        cancelLabel="Cancelar"
        destructive
        loading={rotating}
        onCancel={() => setConfirmRotate(false)}
        onConfirm={rotate}
      />
    </div>
  );
}

/** The link in a read-only box (tap to select it all) and a Copiar button; wraps on a phone. */
function UrlField({ url, label, onCopy }: { url: string; label: string; onCopy: (url: string) => void }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input
        readOnly
        value={url}
        aria-label={`Enlace de ${label}`}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 bg-gray-50 border border-gray-200 rounded px-2 py-2 text-xs font-mono"
      />
      <button
        type="button"
        onClick={() => onCopy(url)}
        className="inline-flex shrink-0 items-center gap-1 bg-gray-100 hover:bg-gray-200 rounded px-3 py-2 text-sm text-gray-700"
      >
        <Copy className="w-4 h-4" /> Copiar
      </button>
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
  onCopy: (url: string) => void;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 sm:p-6">
      <h2 className="font-semibold mb-1">{title}</h2>
      <p className="text-sm text-gray-500 mb-3">{description}</p>
      <UrlField url={url} label={title} onCopy={onCopy} />
    </div>
  );
}

/** One professional's link: the name above the link on a phone, beside it from sm up. */
function FeedRow({
  label,
  url,
  onCopy,
}: {
  label: string;
  url: string;
  onCopy: (url: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1 py-1 sm:flex-row sm:items-center sm:gap-2">
      <span className="flex min-w-0 items-center gap-2 text-sm text-gray-700 sm:w-40 sm:shrink-0">
        <LinkIcon className="w-3 h-3 shrink-0 text-gray-400" />
        <span className="truncate">{label}</span>
      </span>
      <UrlField url={url} label={label} onCopy={onCopy} />
    </div>
  );
}
