/**
 * Lazy-loaded entry point for the 3D + GSAP layer.
 *
 * Strategy:
 *   1. Detect `prefers-reduced-motion: reduce`. If true, do NOTHING
 *      (no Three.js, no GSAP, no Heavy JS). The static fallbacks
 *      inside each component take over.
 *   2. Mount a hero scene and a multichannel scene lazily when their
 *      target `<canvas data-scene="…">` enters the viewport (via
 *      IntersectionObserver). Until then, the static fallback visible
 *      in the HTML carries the visual.
 *   3. Wire CTA clicks to Plausible (if loaded) for funnel analytics.
 *   4. Wire GSAP ScrollTrigger to fade-in the copy sections.
 *
 * Loaded only on the home page (`pages/index.astro` inlines the
 * `<script>` tag).
 */
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { prefersReducedMotion } from "../lib/motion/reducedMotion";
import { createHeroScene } from "../lib/three/heroScene";
import { createMultichannelScene } from "../lib/three/multichannelScene";
import {
  trackCtaClick,
  trackReducedMotion,
  trackSectionView,
  trackThreeDLoaded,
} from "../lib/analytics/plausible";

gsap.registerPlugin(ScrollTrigger);

const init = (): void => {
  const reduced = prefersReducedMotion();
  trackReducedMotion(reduced);

  if (reduced) {
    document.documentElement.classList.add("no-3d");
    return;
  }

  // CTA tracking
  document.querySelectorAll<HTMLAnchorElement>("a[data-cta]").forEach((a) => {
    a.addEventListener("click", () => {
      const id = a.getAttribute("data-cta") ?? "unknown";
      trackCtaClick(id);
    });
  });

  // Section view tracking (50% visibility)
  const sectionObs = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          const id = entry.target.id || entry.target.getAttribute("data-section") || "unknown";
          trackSectionView(id);
          sectionObs.unobserve(entry.target);
        }
      });
    },
    { threshold: [0.5] },
  );
  document.querySelectorAll<HTMLElement>("section[id]").forEach((s) => sectionObs.observe(s));

  // Lazy-load 3D scenes on viewport entry
  const sceneObs = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target as HTMLElement;
        const scene = el.dataset.scene;
        const canvas = el.querySelector<HTMLCanvasElement>("canvas");
        if (!canvas) {
          sceneObs.unobserve(el);
          return;
        }
        // Reserve size for the canvas
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          sceneObs.unobserve(el);
          return;
        }
        try {
          if (scene === "hero") {
            createHeroScene(canvas);
            trackThreeDLoaded("hero");
          } else if (scene === "multichannel") {
            const captionEl = document.querySelector<HTMLParagraphElement>(
              "[data-channel-caption]",
            );
            createMultichannelScene(canvas, (_key, name) => {
              if (captionEl) {
                captionEl.textContent = `${name}: la IA responde con tu tono, tu agenda y tus precios.`;
              }
            });
            trackThreeDLoaded("multichannel");
          }
          el.classList.add("is-loaded");
        } catch (err) {
          // WebGL unavailable: silently fall back to the static markup.
          console.warn("3D scene failed to init", err);
        }
        sceneObs.unobserve(el);
      });
    },
    { rootMargin: "200px 0px" },
  );
  document.querySelectorAll<HTMLElement>("[data-scene]").forEach((el) => sceneObs.observe(el));

  // GSAP copy reveals
  gsap.utils.toArray<HTMLElement>("[data-anim]").forEach((el) => {
    gsap.from(el, {
      y: 30,
      opacity: 0,
      duration: 0.7,
      ease: "power3.out",
      scrollTrigger: {
        trigger: el,
        start: "top 85%",
        toggleActions: "play none none reverse",
      },
    });
  });
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
