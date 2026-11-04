/**
 * The booking widget's embed code (Ajustes > Widget) and the height it
 * reports to the salon's page.
 *
 * The snippet was an iframe 640 px high with no title: the details step is
 * taller than that on a phone, so the widget scrolled inside the salon's own
 * page, and screen readers announced an unnamed frame. Now the iframe has a
 * title, and a small script next to it sets the iframe's height to what the
 * widget reports. The widget posts only a number (its height in px) to its
 * parent, never any data; the script only accepts it from the widget's own
 * origin and from that iframe.
 *
 * Pure (no React, no DOM types beyond what is passed in) so
 * lib/embed-snippet.spec.ts can run it.
 */

/** Taller than any real step; a bigger number is ignored. */
export const MAX_EMBED_HEIGHT = 5000;

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The origin the widget is served from ("https://app.kiraroom.net"). */
export function embedOrigin(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return base.replace(/\/+$/, "");
  }
}

/**
 * The HTML the salon pastes into its site: the iframe, named for the salon,
 * and the script that sizes it.
 */
export function buildEmbedSnippet(token: string, base: string, salonName?: string | null): string {
  const root = base.replace(/\/+$/, "");
  const url = `${root}/embed/${encodeURIComponent(token)}`;
  const id = `kiraroom-widget-${token.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const name = salonName?.trim();
  const title = escapeAttr(name ? `Reservar cita en ${name}` : "Reservar cita");
  // JSON.stringify: the origin and the id go into the script as string
  // literals, whatever they contain.
  const script =
    `(function(){var f=document.getElementById(${JSON.stringify(id)});if(!f)return;` +
    `window.addEventListener("message",function(e){` +
    `if(e.origin!==${JSON.stringify(embedOrigin(root))}||e.source!==f.contentWindow)return;` +
    `var h=e.data;if(typeof h==="number"&&h>0&&h<=${MAX_EMBED_HEIGHT})f.style.height=Math.ceil(h)+"px";});})();`;
  return (
    `<iframe id="${id}" src="${escapeAttr(url)}" title="${title}" width="100%" height="640" ` +
    `style="border:0;border-radius:12px" loading="lazy"></iframe>\n<script>${script}</script>`
  );
}

/**
 * Tells the page around the widget how tall it is: a bare number, sent only
 * when it changed by a pixel or more. Any origin may receive it (the salon's
 * site is not known here), which is why it carries nothing else.
 */
let lastSent = 0;
export function postEmbedHeight(parent: { postMessage(message: unknown, targetOrigin: string): void }, height: number): boolean {
  const h = Math.ceil(height);
  if (!Number.isFinite(h) || h <= 0 || h > MAX_EMBED_HEIGHT || Math.abs(h - lastSent) < 1) return false;
  lastSent = h;
  parent.postMessage(h, "*");
  return true;
}
