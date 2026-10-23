"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Copy, Check, ExternalLink, Mail, MessageCircle, Share2, Download, Printer, Image as ImageIcon, QrCode } from "lucide-react";
import apiClient from "@/lib/api";
import {
  ShareInfo,
  PRINT_FORMATS,
  displayUrl,
  emailShareUrl,
  qrTargetUrl,
  shareFileName,
  shareMessage,
  whatsappShareUrl,
} from "@/lib/share-page";
import { downloadQrPng, downloadQrSvg, qrSvg, saveBlob, socialImage } from "@/lib/share-download";

type Named = { id: string; label: string };

/** A QR code drawn in the browser from the address. */
function Qr({ url, className }: { url: string; className?: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    let alive = true;
    qrSvg(url).then((s) => alive && setSvg(s));
    return () => {
      alive = false;
    };
  }, [url]);
  // The SVG comes from the qrcode library, not from user input.
  return <div className={className} aria-label={`Código QR de ${url}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

const card = "rounded-xl border border-gray-200 bg-white p-5";
const btn =
  "inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50";
const primary = "inline-flex items-center gap-2 rounded-lg bg-violet-700 px-3 py-2 text-sm font-medium text-white hover:bg-violet-800";

export default function SharePage() {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  const [social, setSocial] = useState<{ blob: Blob; href: string } | null>(null);
  const [professionals, setProfessionals] = useState<Named[]>([]);
  const [services, setServices] = useState<Named[]>([]);

  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
    apiClient
      .getShareInfo()
      .then(setInfo)
      .catch(() => setError("No se ha podido cargar la dirección de tu página. Recarga para intentarlo de nuevo."));
    apiClient
      .getProfessionals()
      .then((list: any[]) =>
        setProfessionals(
          (list ?? [])
            .filter((p) => p.isActive !== false)
            .map((p) => ({ id: p.id, label: [p.firstName, p.lastName].filter(Boolean).join(" ") })),
        ),
      )
      .catch(() => undefined);
    apiClient
      .getServices()
      .then((list: any[]) =>
        setServices((list ?? []).filter((s) => s.isActive !== false).map((s) => ({ id: s.id, label: s.name }))),
      )
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!info) return;
    let href = "";
    socialImage({ name: info.name, url: info.url })
      .then((blob) => {
        href = URL.createObjectURL(blob);
        setSocial({ blob, href });
      })
      .catch(() => undefined);
    return () => {
      if (href) URL.revokeObjectURL(href);
    };
  }, [info]);

  const message = useMemo(() => (info ? shareMessage(info.name, info.url) : ""), [info]);

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!info) return <p className="text-sm text-gray-500">Cargando…</p>;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copia la dirección:", info.url);
    }
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title: info.name, text: message, url: info.url });
    } catch {
      /* the client closed the share sheet */
    }
  };

  const shareSocial = async () => {
    if (!social) return;
    const file = new File([social.blob], shareFileName(info.slug, "redes", "png"), { type: "image/png" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: message });
      } catch {
        /* closed */
      }
    } else {
      saveBlob(social.blob, file.name);
    }
  };

  const printHref = (format: string, filter?: { profesional?: string; servicio?: string }) => {
    const q = new URLSearchParams({ formato: format, ...(filter ?? {}) });
    return `/imprimir/qr?${q.toString()}`;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Comparte tu página</h1>
        <p className="mt-1 text-sm text-gray-600">
          Tu página de reservas, su código QR y material listo para imprimir o compartir. Tus clientas reservan
          desde el móvil a cualquier hora.
        </p>
      </div>

      {/* 1. The link */}
      <section className={card}>
        <h2 className="text-base font-semibold text-gray-900">Tu página de reservas</h2>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            readOnly
            value={info.url}
            className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800"
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={copy} className={primary}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copiada" : "Copiar"}
            </button>
            <a href={info.url} target="_blank" rel="noreferrer" className={btn}>
              <ExternalLink className="h-4 w-4" /> Abrir
            </a>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href={whatsappShareUrl(info.name, info.url)} target="_blank" rel="noreferrer" className={btn}>
            <MessageCircle className="h-4 w-4" /> Enviar por WhatsApp
          </a>
          <a href={emailShareUrl(info.name, info.url)} className={btn}>
            <Mail className="h-4 w-4" /> Enviar por email
          </a>
          {canShare && (
            <button type="button" onClick={nativeShare} className={btn}>
              <Share2 className="h-4 w-4" /> Compartir…
            </button>
          )}
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Pon este enlace en tu perfil de Instagram, en tu ficha de Google y en tu estado de WhatsApp.
        </p>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        {/* 2. The QR code */}
        <section className={card}>
          <h2 className="text-base font-semibold text-gray-900">Código QR</h2>
          <p className="mt-1 text-sm text-gray-600">Abre tu página al escanearlo con la cámara del móvil.</p>
          <div className="mt-4 flex items-center gap-4">
            <Qr url={qrTargetUrl(info.url)} className="h-36 w-36 shrink-0 [&>svg]:h-full [&>svg]:w-full" />
            <div className="flex flex-col gap-2">
              <button type="button" className={btn} onClick={() => downloadQrPng(qrTargetUrl(info.url), shareFileName(info.slug, "qr", "png"))}>
                <Download className="h-4 w-4" /> Descargar PNG
              </button>
              <button type="button" className={btn} onClick={() => downloadQrSvg(qrTargetUrl(info.url), shareFileName(info.slug, "qr", "svg"))}>
                <Download className="h-4 w-4" /> Descargar SVG
              </button>
              <p className="text-xs text-gray-500">El SVG es para imprenta: se amplía sin perder calidad.</p>
            </div>
          </div>
        </section>

        {/* 4. Image for social media */}
        <section className={card}>
          <h2 className="text-base font-semibold text-gray-900">Imagen para redes</h2>
          <p className="mt-1 text-sm text-gray-600">Para tu estado de WhatsApp, Instagram o una publicación.</p>
          <div className="mt-4 flex items-center gap-4">
            {social ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={social.href} alt={`Imagen para redes de ${info.name}`} className="h-36 w-36 shrink-0 rounded-lg border border-gray-200" />
            ) : (
              <div className="flex h-36 w-36 shrink-0 items-center justify-center rounded-lg bg-gray-50 text-gray-400">
                <ImageIcon className="h-6 w-6" />
              </div>
            )}
            <div className="flex flex-col gap-2">
              <button type="button" className={btn} disabled={!social} onClick={() => social && saveBlob(social.blob, shareFileName(info.slug, "redes", "png"))}>
                <Download className="h-4 w-4" /> Descargar imagen
              </button>
              {canShare && (
                <button type="button" className={btn} disabled={!social} onClick={shareSocial}>
                  <Share2 className="h-4 w-4" /> Compartir imagen
                </button>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* 3. Printables */}
      <section className={card}>
        <h2 className="text-base font-semibold text-gray-900">Para imprimir</h2>
        <p className="mt-1 text-sm text-gray-600">
          Se abre una página lista para imprimir. Desde ahí también puedes guardarla en PDF y llevarla a la imprenta.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PRINT_FORMATS.map((f) => (
            <a key={f.id} href={printHref(f.id)} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-200 p-4 hover:border-violet-300 hover:bg-violet-50">
              <div className="flex items-center gap-2 font-medium text-gray-900">
                <Printer className="h-4 w-4 text-violet-700" /> {f.title}
              </div>
              <p className="mt-1 text-xs text-gray-600">{f.description}</p>
            </a>
          ))}
        </div>
      </section>

      {/* 5. Per professional and per service */}
      {(professionals.length > 0 || services.length > 0) && (
        <section className={card}>
          <h2 className="text-base font-semibold text-gray-900">QR de cada profesional y de cada servicio</h2>
          <p className="mt-1 text-sm text-gray-600">
            Abren tu página con la profesional o el servicio ya elegidos. Para el puesto de cada profesional o junto a un
            servicio destacado.
          </p>
          <div className="mt-4 grid gap-6 md:grid-cols-2">
            {[
              { title: "Profesionales", items: professionals, key: "professionalId" as const, print: "profesional" as const },
              { title: "Servicios", items: services, key: "serviceId" as const, print: "servicio" as const },
            ]
              .filter((g) => g.items.length > 0)
              .map((g) => (
                <div key={g.title}>
                  <h3 className="text-sm font-semibold text-gray-700">{g.title}</h3>
                  <ul className="mt-2 divide-y divide-gray-100">
                    {g.items.map((it) => {
                      const target = qrTargetUrl(info.url, { [g.key]: it.id });
                      return (
                        <li key={it.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                          <span className="flex items-center gap-2 text-gray-800">
                            <QrCode className="h-4 w-4 text-gray-400" /> {it.label}
                          </span>
                          <span className="flex shrink-0 gap-3">
                            <button
                              type="button"
                              className="text-violet-700 hover:underline"
                              onClick={() => downloadQrPng(target, shareFileName(info.slug, "qr", "png", it.label))}
                            >
                              PNG
                            </button>
                            <a className="text-violet-700 hover:underline" href={printHref("cartel-a5", { [g.print]: it.id })} target="_blank" rel="noreferrer">
                              Cartel
                            </a>
                            <a className="text-violet-700 hover:underline" href={printHref("pegatinas", { [g.print]: it.id })} target="_blank" rel="noreferrer">
                              Pegatinas
                            </a>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
          </div>
        </section>
      )}

      <p className="text-xs text-gray-500">
        Todos los códigos llevan a {displayUrl(info.url)}. Si más adelante activas un dominio propio, los nuevos usarán esa
        dirección y los ya impresos seguirán funcionando. ¿Quieres usar tu dominio?{" "}
        <Link href="/dashboard/settings/domain" className="text-violet-700 hover:underline">
          Configúralo aquí
        </Link>
        .
      </p>
    </div>
  );
}
