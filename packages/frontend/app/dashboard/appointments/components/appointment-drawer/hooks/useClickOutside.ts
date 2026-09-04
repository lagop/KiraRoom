import { useEffect, type RefObject } from "react";

/**
 * Calls `handler` whenever a `mousedown` event occurs outside the
 * element referenced by `ref`. Used by the client-suggestions
 * dropdown today; reusable for any future popover/dropdown.
 *
 * Verbatim move from the inline `useEffect` + `handleClickOutside`
 * in `appointment-drawer.tsx:678-691`.
 */
export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T>,
  handler: () => void,
): void {
  useEffect(() => {
    const listener = (event: MouseEvent) => {
      const el = ref.current;
      if (!el || el.contains(event.target as Node)) return;
      handler();
    };
    document.addEventListener("mousedown", listener);
    return () => document.removeEventListener("mousedown", listener);
    // The hook closes over `ref` and `handler`; consumers wrap `handler`
    // in useCallback when they need stable identity. We intentionally
    // don't list `handler` here to avoid surprising re-subscriptions
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref]);
}