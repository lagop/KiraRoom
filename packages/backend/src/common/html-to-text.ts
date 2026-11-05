/**
 * The plain-text part of an HTML email.
 *
 * Campaign emails went out as HTML only. Mail clients that read text (and
 * spam filters, which weigh an HTML-only message as suspect) got nothing
 * readable. This turns the salon's HTML into text: block elements become
 * line breaks, list items start with "- ", a link keeps its address in
 * brackets after the words, entities are decoded and the rest of the markup
 * is dropped. It is not a full HTML parser and does not need to be: the
 * input is a short marketing email, and the output is a fallback.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  euro: "€",
  iexcl: "¡",
  iquest: "¿",
  laquo: "«",
  raquo: "»",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  uuml: "ü",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
  ordm: "º",
  ordf: "ª",
  copy: "©",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[code] ?? NAMED_ENTITIES[code.toLowerCase()] ?? whole;
  });
}

export function htmlToText(html: string): string {
  let s = String(html ?? "");
  // What is never shown: head, styles, scripts, comments, hidden preheaders.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<([a-z][a-z0-9]*)\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/\1\s*>/gi, "");

  // A link keeps its address: "Reserva aquí (https://...)". A link whose
  // text is its address, or a mailto/anchor, keeps only the text.
  s = s.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, href: string, inner: string) => {
    const words = inner.replace(/<[^>]+>/g, "").trim();
    const url = decodeEntities(href.trim());
    if (!url || url.startsWith("#") || /^mailto:/i.test(url) || decodeEntities(words) === url) return inner;
    return words ? `${inner} (${url})` : url;
  });

  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<hr\b[^>]*>/gi, "\n----------\n");
  s = s.replace(/<\/(p|div|h[1-6]|ul|ol|table|blockquote|section|article|header|footer)\s*>/gi, "\n\n");
  s = s.replace(/<(p|div|h[1-6]|ul|ol|table|blockquote|section|article|header|footer)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/tr\s*>/gi, "\n");
  s = s.replace(/<\/t[dh]\s*>/gi, " ");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);

  return s
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
