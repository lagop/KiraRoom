/**
 * The booking widget in the salon's main colour (the widget's theme, set in
 * Ajustes > Widget). The widget is drawn with the app's purple classes; with
 * a colour set, a scoped stylesheet paints those same classes with it. Where
 * the browser lacks color-mix() the tints fall back to the purple. Pure:
 * tested in embed-theme.spec.ts.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

/** "#1A2b3C" -> "#1a2b3c"; null for anything that is not a 6-digit hex colour. */
export function validHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return HEX.test(v) ? v.toLowerCase() : null;
}

/** WCAG relative luminance of a hex colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The text colour on the main colour: white, or near-black on a light one. */
export function onColor(hex: string): string {
  const l = luminance(hex);
  // Whichever of the two gives the higher contrast ratio.
  const withWhite = 1.05 / (l + 0.05);
  const withDark = (l + 0.05) / (luminance("#111827") + 0.05);
  return withWhite >= withDark ? "#ffffff" : "#111827";
}

/** The attribute the scoped stylesheet hangs on. */
export const EMBED_THEME_ATTR = "data-kr-theme";

/**
 * The CSS custom properties and the stylesheet for a colour, or null for
 * none (the default purple stays).
 */
export function embedTheme(primaryColor: unknown): { vars: Record<string, string>; css: string } | null {
  const color = validHexColor(primaryColor);
  if (!color) return null;
  const scope = `[${EMBED_THEME_ATTR}]`;
  const tint = (pct: number) => `color-mix(in srgb, var(--kr-primary) ${pct}%, white)`;
  const shade = `color-mix(in srgb, var(--kr-primary) 85%, black)`;
  const css = [
    `${scope} .bg-purple-600{background-color:var(--kr-primary);color:var(--kr-on-primary)}`,
    `${scope} .hover\\:bg-purple-700:hover{background-color:${shade}}`,
    `${scope} .text-purple-600,${scope} .hover\\:text-purple-700:hover{color:var(--kr-primary)}`,
    `${scope} .border-purple-500{border-color:var(--kr-primary)}`,
    `${scope} .hover\\:border-purple-300:hover{border-color:${tint(50)}}`,
    `${scope} .border-purple-200{border-color:${tint(35)}}`,
    `${scope} .bg-purple-50{background-color:${tint(10)}}`,
  ].join("\n");
  return { vars: { "--kr-primary": color, "--kr-on-primary": onColor(color) }, css };
}
