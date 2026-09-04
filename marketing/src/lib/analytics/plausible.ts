/**
 * Plausible Analytics wrapper.
 *
 * Plausible is privacy-first: no cookies, no personal data, no
 * fingerprinting. According to its docs it does not require GDPR
 * consent (RGPD in Spain). It is exposed here as a typed module
 * that degrades to a no-op when:
 *
 *   - The script tag is not present (Plausible not configured for
 *     this environment; e.g. runtime env var missing).
 *   - The user has explicitly opted out via `localStorage` flag
 *     `kira-analytics-opt-out` (set by the cookie banner).
 *   - `window.plausible` has not loaded yet (deferred script).
 *
 * Public events (per plan §5.3):
 *   - `pageview`            (issued automatically by Plausible script)
 *   - `cta_click`     { props: { cta_id: string } }
 *   - `section_view`  { props: { section: string } }
 *   - `three_d_loaded`{ props: { scene: 'hero' | 'multichannel' } }
 *   - `reduced_motion`{ props: { value: 'true' | 'false' } }
 *
 * The `props` field is supported by Plausible's "custom properties"
 * feature (paid tier). On the open-source tier the second argument is
 * ignored — events still record, just without the breakdown. We pass
 * it anyway for forward compatibility.
 */

declare global {
  interface Window {
    plausible?: (
      event: string,
      options?: { props?: Record<string, string | number | boolean> },
    ) => void;
  }
}

const OPTOUT_KEY = "kira-analytics-opt-out";

const isOptedOut = (): boolean => {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(OPTOUT_KEY) === "1";
  } catch {
    return false;
  }
};

const fire = (event: string, props?: Record<string, string | number | boolean>): void => {
  if (typeof window === "undefined") return;
  if (isOptedOut()) return;
  if (typeof window.plausible !== "function") return;
  try {
    window.plausible(event, props ? { props } : undefined);
  } catch {
    /* swallow — analytics is best-effort */
  }
};

export const trackCtaClick = (ctaId: string): void => {
  fire("cta_click", { cta_id: ctaId });
};

export const trackSectionView = (section: string): void => {
  fire("section_view", { section });
};

export const trackThreeDLoaded = (scene: "hero" | "multichannel"): void => {
  fire("three_d_loaded", { scene });
};

export const trackReducedMotion = (value: boolean): void => {
  fire("reduced_motion", { value: value ? "true" : "false" });
};
