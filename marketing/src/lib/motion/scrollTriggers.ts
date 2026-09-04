/**
 * GSAP ScrollTrigger setup helpers.
 *
 * The bulk of the scroll-trigger setup lives in
 * `scripts/scene-init.client.ts` (so it benefits from the
 * `prefers-reduced-motion` short-circuit and the IntersectionObserver
 * lazy-load). This file is reserved for shared animation primitives
 * that future pages may reuse (e.g. pinned horizontal scroll for the
 * addons strip on mobile).
 */
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/**
 * Pin a section and translate its inner track horizontally based on
 * the section's vertical scroll progress. Used by the addons strip on
 * tablet+ viewports.
 */
export const pinHorizontalTrack = (
  section: HTMLElement,
  track: HTMLElement,
): ScrollTrigger => {
  return ScrollTrigger.create({
    trigger: section,
    start: "top top",
    end: () => `+=${track.scrollWidth - window.innerWidth}`,
    pin: true,
    scrub: 0.5,
    invalidateOnRefresh: true,
    animation: gsap.to(track, {
      x: () => -(track.scrollWidth - window.innerWidth),
      ease: "none",
    }),
  });
};
