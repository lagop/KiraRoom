"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import apiClient from "@/lib/api";
import { ShareInfo, PRINT_FORMATS, PrintFormat, displayUrl, isPrintFormat, printHeadline, qrTargetUrl } from "@/lib/share-page";
import { qrSvg } from "@/lib/share-download";

/**
 * Printables for the salon page, from "Comparte tu página": a poster (A4 or
 * A5), a sheet of 10 cards (85 × 55 mm) or a sheet of 12 stickers (6 × 6 cm),
 * each with the salon's name, a QR code and the address. Sized in
 * millimetres for print; "Imprimir" opens the browser's dialog, which can
 * also save a PDF for a print shop. Outside the dashboard layout, so no menu
 * or header ends up on paper.
 */
export default function PrintQrPage() {
  return (
    <Suspense fallback={null}>
      <PrintQr />
    </Suspense>
  );
}

function Svg({ svg, size }: { svg: string; size: string }) {
  // The SVG comes from the qrcode library, not from user input.
  return <div style={{ width: size, height: size }} className="[&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function PrintQr() {
  const params = useSearchParams();
  const rawFormat = params?.get("formato") ?? "cartel-a4";
  const format: PrintFormat = isPrintFormat(rawFormat) ? rawFormat : "cartel-a4";
  const professionalId = params?.get("profesional") ?? "";
  const serviceId = params?.get("servicio") ?? "";

  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [label, setLabel] = useState<{ professional?: string; service?: string }>({});
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    apiClient
      .getShareInfo()
      .then(setInfo)
      .catch(() => setError("Inicia sesión en el panel de tu salón y vuelve a abrir esta página."));
    if (professionalId) {
      apiClient
        .getProfessionals()
        .then((list: any[]) => {
          const p = (list ?? []).find((x) => x.id === professionalId);
          if (p) setLabel({ professional: p.firstName });
        })
        .catch(() => undefined);
    }
    if (serviceId) {
      apiClient
        .getServices()
        .then((list: any[]) => {
          const s = (list ?? []).find((x) => x.id === serviceId);
          if (s) setLabel({ service: s.name });
        })
        .catch(() => undefined);
    }
  }, [professionalId, serviceId]);

  const target = info
    ? qrTargetUrl(info.url, { professionalId: professionalId || undefined, serviceId: serviceId || undefined })
    : "";
  useEffect(() => {
    if (target) qrSvg(target).then(setSvg);
  }, [target]);

  if (error) return <p style={{ padding: 24, fontFamily: "system-ui" }}>{error}</p>;
  if (!info || !svg) return <p style={{ padding: 24, fontFamily: "system-ui" }}>Preparando…</p>;

  const headline = printHeadline(label);
  const url = displayUrl(info.url);
  const meta = PRINT_FORMATS.find((f) => f.id === format)!;
  const pageSize = format === "cartel-a5" ? "A5" : "A4";

  return (
    <>
      <style>{`
        @page { size: ${pageSize} portrait; margin: 0; }
        html, body { background: #f3f4f6; }
        @media print {
          html, body { background: #fff; }
          .no-print { display: none !important; }
          .sheet { box-shadow: none !important; margin: 0 !important; }
        }
        .sheet { background: #fff; margin: 16px auto; box-shadow: 0 2px 12px rgba(0,0,0,.12); overflow: hidden;
          font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f1235;
          -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      `}</style>

      <div className="no-print" style={{ maxWidth: 820, margin: "16px auto 0", padding: "12px 16px", background: "#fff", borderRadius: 12, fontFamily: "system-ui", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>{meta.title}</strong>
        <span style={{ fontSize: 13, color: "#4b5563", flex: 1 }}>
          En la ventana de impresión elige papel {pageSize}, escala 100 % y sin márgenes. Para la imprenta, guarda como PDF.
        </span>
        <button
          type="button"
          onClick={() => window.print()}
          style={{ background: "#6d28d9", color: "#fff", border: 0, borderRadius: 8, padding: "8px 14px", fontWeight: 600, cursor: "pointer" }}
        >
          Imprimir o guardar en PDF
        </button>
      </div>

      {(format === "cartel-a4" || format === "cartel-a5") && (
        <Poster a5={format === "cartel-a5"} name={info.name} logo={info.logo} headline={headline} url={url} svg={svg} />
      )}
      {format === "tarjetas" && <Cards name={info.name} headline={headline} url={url} svg={svg} />}
      {format === "pegatinas" && <Stickers name={info.name} headline={headline} svg={svg} />}
    </>
  );
}

function Poster(p: { a5: boolean; name: string; logo: string | null; headline: string; url: string; svg: string }) {
  const k = p.a5 ? 0.7 : 1; // A5 is A4 scaled by ~0.7
  const mm = (n: number) => `${(n * k).toFixed(1)}mm`;
  return (
    <div
      className="sheet"
      style={{ width: p.a5 ? "148mm" : "210mm", height: p.a5 ? "210mm" : "297mm", padding: mm(18), boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "space-between", textAlign: "center" }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: mm(4) }}>
        {p.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.logo} alt="" style={{ maxHeight: mm(26), maxWidth: mm(90), objectFit: "contain" }} />
        ) : null}
        <div style={{ fontSize: `${24 * k}pt`, fontWeight: 700, color: "#5b21b6" }}>{p.name}</div>
      </div>
      <div>
        <div style={{ fontSize: `${44 * k}pt`, fontWeight: 800, lineHeight: 1.05 }}>{p.headline}</div>
        <div style={{ fontSize: `${17 * k}pt`, marginTop: mm(5), color: "#4b5563" }}>Desde el móvil, en un minuto, a cualquier hora</div>
      </div>
      <div style={{ border: `${(1.2 * k).toFixed(1)}mm solid #6d28d9`, borderRadius: mm(8), padding: mm(6) }}>
        <Svg svg={p.svg} size={mm(110)} />
      </div>
      <div>
        <div style={{ fontSize: `${15 * k}pt`, color: "#4b5563" }}>Escanea con la cámara del móvil o entra en</div>
        <div style={{ fontSize: `${19 * k}pt`, fontWeight: 700, marginTop: mm(2), wordBreak: "break-all" }}>{p.url}</div>
      </div>
    </div>
  );
}

function Cards(p: { name: string; headline: string; url: string; svg: string }) {
  return (
    <div
      className="sheet"
      style={{ width: "210mm", height: "297mm", padding: "11mm 20mm", boxSizing: "border-box", display: "grid", gridTemplateColumns: "85mm 85mm", gridAutoRows: "55mm", justifyContent: "center", alignContent: "center" }}
    >
      {Array.from({ length: 10 }, (_, i) => (
        <div key={i} style={{ border: "0.2mm dashed #c4b5fd", boxSizing: "border-box", padding: "5mm", display: "flex", alignItems: "center", gap: "4mm" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: "11pt", fontWeight: 700, color: "#5b21b6", lineHeight: 1.15 }}>{p.name}</div>
            <div style={{ fontSize: "10pt", fontWeight: 700, marginTop: "2mm", lineHeight: 1.15 }}>{p.headline}</div>
            <div style={{ fontSize: "7.5pt", color: "#4b5563", marginTop: "1.5mm" }}>Online, 24 h</div>
            <div style={{ fontSize: "7pt", fontWeight: 600, marginTop: "2.5mm", wordBreak: "break-all" }}>{p.url}</div>
          </div>
          <Svg svg={p.svg} size="36mm" />
        </div>
      ))}
    </div>
  );
}

function Stickers(p: { name: string; headline: string; svg: string }) {
  return (
    <div
      className="sheet"
      style={{ width: "210mm", height: "297mm", padding: "28mm 15mm", boxSizing: "border-box", display: "grid", gridTemplateColumns: "repeat(3, 60mm)", gridAutoRows: "60mm", justifyContent: "center", alignContent: "center" }}
    >
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} style={{ border: "0.2mm dashed #c4b5fd", borderRadius: "5mm", boxSizing: "border-box", padding: "3mm", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          <div style={{ fontSize: "9pt", fontWeight: 800, lineHeight: 1.1 }}>{p.headline}</div>
          <Svg svg={p.svg} size="38mm" />
          <div style={{ fontSize: "7pt", fontWeight: 700, color: "#5b21b6", lineHeight: 1.1 }}>{p.name}</div>
        </div>
      ))}
    </div>
  );
}
