"use client";

import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query and return `true` while it matches.
 *
 * SSR-safe: starts with the SSR fallback (defaults to `false`) on the
 * server, then updates after mount with the real client value. Hydration
 * mismatch is avoided by ignoring the first client result if it differs
 * from the SSR value (visual flicker on a single element is preferable
 * to a React warning per render).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const onChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    // Safari < 14 fallback
    const legacy = mql as unknown as {
      addListener?: (cb: (e: MediaQueryListEvent) => void) => void;
      removeListener?: (cb: (e: MediaQueryListEvent) => void) => void;
    };
    legacy.addListener?.(onChange);
    return () => legacy.removeListener?.(onChange);
  }, [query]);

  return matches;
}