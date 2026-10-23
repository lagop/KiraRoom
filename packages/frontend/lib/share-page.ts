/**
 * Sharing the salon's booking page: the message, the WhatsApp and email
 * links, the address each QR code points to, and the printable formats.
 * Pure, so the rules are tested without the browser (share-page.spec.ts).
 */

export interface ShareInfo {
  name: string;
  slug: string;
  logo: string | null;
  /** The salon's real address: own domain, subdomain or /sites/<slug>. */
  url: string;
}

/** The text that goes with the link, in WhatsApp, email or the phone's share sheet. */
export function shareMessage(name: string, url: string): string {
  return `Reserva tu cita en ${name} en un minuto, a cualquier hora: ${url}`;
}

export function whatsappShareUrl(name: string, url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(shareMessage(name, url))}`;
}

export function emailShareUrl(name: string, url: string): string {
  const subject = `Reserva tu cita en ${name}`;
  const body = `Hola:\n\nYa puedes reservar tu cita en ${name} desde el móvil, a cualquier hora:\n${url}\n\n¡Te esperamos!`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * The address a QR code opens: the salon page, or the same page with a
 * professional or a service already chosen (the booking page reads
 * professionalId / serviceId).
 */
export function qrTargetUrl(base: string, filter?: { professionalId?: string; serviceId?: string }): string {
  const url = new URL(base);
  if (filter?.professionalId) url.searchParams.set("professionalId", filter.professionalId);
  if (filter?.serviceId) url.searchParams.set("serviceId", filter.serviceId);
  return url.toString();
}

/** The address without the scheme or a trailing slash, for printing under a QR. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export type PrintFormat = "cartel-a4" | "cartel-a5" | "tarjetas" | "pegatinas";

export interface PrintFormatInfo {
  id: PrintFormat;
  title: string;
  description: string;
  /** Pieces per A4 sheet (1 for posters). */
  perSheet: number;
}

export const PRINT_FORMATS: ReadonlyArray<PrintFormatInfo> = [
  { id: "cartel-a4", title: "Cartel A4", description: "Para el escaparate o la puerta.", perSheet: 1 },
  { id: "cartel-a5", title: "Cartel A5", description: "Para el mostrador o la recepción.", perSheet: 1 },
  {
    id: "tarjetas",
    title: "Tarjetas para clientas",
    description: "10 por hoja A4, del tamaño de una tarjeta de visita (85 × 55 mm). Para recortar y dar en caja.",
    perSheet: 10,
  },
  {
    id: "pegatinas",
    title: "Pegatinas",
    description: "12 por hoja A4 (6 × 6 cm). Para el espejo, la caja o los productos.",
    perSheet: 12,
  },
];

export function isPrintFormat(value: string | null | undefined): value is PrintFormat {
  return PRINT_FORMATS.some((f) => f.id === value);
}

/** Headline on printables: "Reserva tu cita", or with a professional or service named. */
export function printHeadline(opts: { professional?: string | null; service?: string | null }): string {
  if (opts.professional) return `Reserva tu cita con ${opts.professional}`;
  if (opts.service) return `Reserva ${opts.service}`;
  return "Reserva tu cita";
}

/** File name for a downloaded QR or image, from the salon's slug. */
export function shareFileName(slug: string, kind: "qr" | "redes", ext: "png" | "svg", suffix = ""): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  return [kind, clean(slug), suffix ? clean(suffix) : ""].filter(Boolean).join("-") + `.${ext}`;
}
