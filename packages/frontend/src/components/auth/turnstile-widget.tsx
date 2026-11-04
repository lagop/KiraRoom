"use client";

import { useEffect, useRef } from "react";
import { turnstileSiteKey } from "@/lib/signup-form";

/**
 * Cloudflare Turnstile, the captcha on signup, forgot-password and (after
 * 3 failed sign-ins) login. The server checks the token it produces
 * (TURNSTILE_SECRET_KEY). Renders nothing when the image was built without
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY, so the forms work as before.
 *
 * Tokens are single use: after a refused submit the form changes `resetKey`
 * to get a fresh challenge.
 */

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error("turnstile script"));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export function isTurnstileConfigured(): boolean {
  return Boolean(turnstileSiteKey());
}

export function TurnstileWidget({
  onToken,
  resetKey = 0,
  action,
}: {
  /** The token once the challenge is passed; null when it expires or fails. */
  onToken: (token: string | null) => void;
  /** Change it to start a new challenge (after a refused submit). */
  resetKey?: number;
  /** Shown in Cloudflare's analytics: "signup", "login", "forgot-password". */
  action?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const siteKey = turnstileSiteKey();
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (!siteKey || !ref.current) return;
    let widgetId: string | null = null;
    let cancelled = false;
    onTokenRef.current(null);
    loadScript()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile) return;
        widgetId = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          action,
          language: "es",
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
        });
      })
      .catch(() => {
        // The script did not load (blocked, offline): the server decides.
        onTokenRef.current(null);
      });
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey, resetKey, action]);

  if (!siteKey) return null;
  return <div ref={ref} className="min-h-[65px]" />;
}
