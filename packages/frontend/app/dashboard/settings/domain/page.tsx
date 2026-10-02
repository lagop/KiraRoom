"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Clock, Copy, ExternalLink, Globe, Loader2, AlertTriangle } from "lucide-react";
import apiClient, { type WebDomainStatus } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";

/**
 * The salon's public page and its own domain.
 *
 * This replaces the "Web con dominio propio + SEO" add-on card in billing,
 * which "checked availability" by suffix and "bought" a domain by flipping a
 * flag: nothing was registered, paid or served. Here the salon connects a
 * domain it already owns, with two DNS records we check for real. Serving
 * the page on that domain also needs HTTPS certificates for customer
 * domains, which the platform does not issue yet; the page says so instead
 * of pretending.
 */
export default function DomainSettingsPage() {
  const { toast } = useToast();
  const [status, setStatus] = useState<WebDomainStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "verify" | "remove">(null);

  useEffect(() => {
    apiClient
      .getWebDomain()
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : "Error"));
  }, []);

  const run = async (kind: "save" | "verify" | "remove", call: () => Promise<WebDomainStatus>) => {
    setBusy(kind);
    setError(null);
    try {
      const next = await call();
      setStatus(next);
      if (kind === "save") setEditing(false);
      if (kind === "verify") {
        toast({
          title: next.domain?.verified ? "Dominio verificado" : "Todavía no está bien",
          description: next.domain?.verified
            ? undefined
            : next.domain?.lastCheckError ?? "Revisa los registros DNS.",
          variant: next.domain?.verified ? undefined : "destructive",
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setBusy(null);
    }
  };

  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(() => toast({ title: "Copiado" }));

  const domain = status?.domain ?? null;
  const showForm = !domain || editing;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Globe className="w-6 h-6 text-purple-600" /> Tu web y dominio
        </h1>
        <p className="text-gray-500 mt-1">
          La página pública de tu salón, donde tus clientes reservan, y el dominio en el que se ve.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">{error}</div>
      )}

      {!status && !error && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando…
        </div>
      )}

      {status && (
        <>
          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="font-semibold mb-1">Tu página pública</h2>
            <p className="text-sm text-gray-500 mb-3">
              Los buscadores pueden leerla: nombre, descripción, servicios con precios, dirección, horario y
              equipo, y aparece en el mapa del sitio (sitemap). Salir en Google depende de Google y puede
              tardar semanas. Cuanto más completos estén los datos del salón, mejor.
            </p>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={status.publicUrl}
                className="flex-1 bg-gray-50 border border-gray-200 rounded px-2 py-1 text-sm font-mono"
              />
              <button
                onClick={() => copy(status.publicUrl)}
                className="bg-gray-100 hover:bg-gray-200 p-2 rounded"
                aria-label="Copiar enlace"
              >
                <Copy className="w-4 h-4" />
              </button>
              <a
                href={status.publicUrl}
                target="_blank"
                rel="noreferrer"
                className="bg-gray-100 hover:bg-gray-200 p-2 rounded"
                aria-label="Abrir página"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
            <div>
              <h2 className="font-semibold mb-1">Tu propio dominio</h2>
              <p className="text-sm text-gray-500">
                Si ya tienes un dominio (por ejemplo misalon.com), puedes mostrar tu página en él. No vendemos
                dominios: necesitas uno tuyo y acceso a su configuración DNS, en la empresa donde lo compraste.
              </p>
            </div>

            {!status.servingEnabled && (
              <div className="flex gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  Puedes conectar y verificar tu dominio ya, pero tu página todavía no se mostrará en él: falta
                  que activemos los certificados de seguridad (HTTPS) para dominios de salones. Mientras tanto,
                  tu página sigue funcionando en la dirección de arriba.
                </span>
              </div>
            )}

            {domain && !editing && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-base">{domain.name}</span>
                  <DomainBadge status={status} />
                </div>

                {domain.lastCheckError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                    {domain.verified ? "La última comprobación falló: " : ""}
                    {domain.lastCheckError}
                  </div>
                )}

                <div>
                  <p className="text-sm text-gray-700 mb-2">
                    Crea estos dos registros en el DNS de tu dominio y pulsa «Comprobar ahora». Los cambios de
                    DNS pueden tardar desde minutos hasta unas horas en verse.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase text-gray-500">
                        <tr>
                          <th className="py-1 pr-3">Tipo</th>
                          <th className="py-1 pr-3">Nombre</th>
                          <th className="py-1 pr-3">Valor</th>
                        </tr>
                      </thead>
                      <tbody>
                        {domain.records.map((r) => (
                          <tr key={r.type} className="border-t border-gray-100 align-top">
                            <td className="py-2 pr-3 font-medium">{r.type}</td>
                            <td className="py-2 pr-3">
                              <CopyValue value={r.name} onCopy={copy} />
                            </td>
                            <td className="py-2 pr-3">
                              <CopyValue value={r.value} onCopy={copy} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    El TXT demuestra que el dominio es tuyo. Si tu proveedor pide el nombre sin el dominio, escribe
                    solo la primera parte (por ejemplo <span className="font-mono">_kiraroom</span>).
                    {domain.targetIps.length > 0 && (
                      <>
                        {" "}Si usas el dominio sin «www» (misalon.com) y tu proveedor no permite CNAME ahí, crea en su
                        lugar un registro A hacia{" "}
                        <span className="font-mono">{domain.targetIps.join(", ")}</span>.
                      </>
                    )}
                  </p>
                </div>

                {domain.lastCheckedAt && (
                  <p className="text-xs text-gray-400">
                    Última comprobación: {new Date(domain.lastCheckedAt).toLocaleString("es-ES")}
                  </p>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => run("verify", () => apiClient.verifyWebDomain())}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    {busy === "verify" && <Loader2 className="w-4 h-4 animate-spin" />}
                    Comprobar ahora
                  </button>
                  <button
                    onClick={() => {
                      setInput(domain.name);
                      setEditing(true);
                    }}
                    disabled={busy !== null}
                    className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Cambiar dominio
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`¿Desconectar ${domain.name}? Tu página seguirá en ${status.publicUrl}.`)) {
                        void run("remove", () => apiClient.removeWebDomain());
                      }
                    }}
                    disabled={busy !== null}
                    className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    Desconectar
                  </button>
                </div>
              </div>
            )}

            {showForm && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("save", () => apiClient.setWebDomain(input));
                }}
                className="space-y-2"
              >
                <label htmlFor="domain" className="block text-sm font-medium text-gray-700">
                  Dominio
                </label>
                <div className="flex flex-wrap gap-2">
                  <input
                    id="domain"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="reservas.misalon.com"
                    autoComplete="off"
                    className="flex-1 min-w-[220px] rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
                  />
                  <button
                    type="submit"
                    disabled={!input.trim() || busy !== null}
                    className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    {busy === "save" && <Loader2 className="w-4 h-4 animate-spin" />}
                    Guardar
                  </button>
                  {editing && (
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      Cancelar
                    </button>
                  )}
                </div>
                <p className="text-xs text-gray-500">
                  Recomendado: un subdominio como <span className="font-mono">reservas.misalon.com</span> o{" "}
                  <span className="font-mono">www.misalon.com</span>. Si cambias de dominio tendrás que volver a
                  crear los registros.
                </p>
              </form>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function DomainBadge({ status }: { status: WebDomainStatus }) {
  const d = status.domain!;
  if (d.active) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
        <CheckCircle2 className="w-3.5 h-3.5" /> Activo
      </span>
    );
  }
  if (d.verified) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-semibold text-sky-700">
        <CheckCircle2 className="w-3.5 h-3.5" /> Verificado; activo cuando se configure el certificado
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-semibold text-gray-700">
      <Clock className="w-3.5 h-3.5" /> Pendiente de verificar
    </span>
  );
}

function CopyValue({ value, onCopy }: { value: string; onCopy: (v: string) => void }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="font-mono break-all">{value}</span>
      <button
        type="button"
        onClick={() => onCopy(value)}
        className="p-1 rounded hover:bg-gray-100 shrink-0"
        aria-label={`Copiar ${value}`}
      >
        <Copy className="w-3.5 h-3.5" />
      </button>
    </span>
  );
}
