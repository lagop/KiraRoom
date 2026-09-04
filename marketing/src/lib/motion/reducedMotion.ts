/**
 * Reduced-motion preference helper.
 *
 * Single source of truth for the `prefers-reduced-motion: reduce`
 * detection. Returns `false` on the server (no `window`), so callers
 * running during SSR / SSG can short-circuit without errors.
 *
 * Used by:
 * - `scripts/scene-init.client.ts` to skip the Three.js / GSAP load
 *   entirely when the user prefers no motion.
 * - Components that may want to fall back to a static layout.
 */
export const prefersReducedMotion = (): boolean => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
};

/**
 * CSS class applied to `<html>` by `scripts/scene-init.client.ts` to
 * mark that the 3D layer is disabled. Stylesheets can opt out of
 * transform / animation by scoping to this class.
 */
export const NO_3D_CLASS = "no-3d";
