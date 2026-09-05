"use client";

import { useEffect, useState } from "react";

/**
 * Cookie consent banner for KiraRoom.
 *
 * Implements Spanish LSSI (Art. 22.2) + RGPD (Art. 7 + Art. 13) cookie
 * consent requirements in a Klaro-shaped UI without the Klaro bundle
 * (Klaro is MIT but ~100 KB JS; out of scope for the zero-budget
 * launch window). If Klaro is later adopted, swap this component out
 * — the localStorage shape (`kira-cookie-consent-v2`) is intentionally
 * compatible with a Klaro `klaro` storage key rewrite.
 *
 * Categories tracked:
 *   - necessary   — always on, no UI toggle. Session, auth, CSRF.
 *   - preferences — language, theme, last-viewed salon.
 *   - analytics   — page views, error reporting (GlitchTip).
 *   - marketing   — paid acquisition pixels (Meta, Google Ads). Currently
 *                   unused by the product but reserved so consent is
 *                   explicit before any pixel is added.
 *
 * Persistence: `localStorage["kira-cookie-consent-v2"]` (JSON). The
 * version bump from v1 → v2 resets all users to "no consent" so they
 * are re-prompted under the new scheme (necessary + explicit opt-in
 * for everything else).
 *
 * On any change, dispatch a `kira:consent-changed` CustomEvent so the
 * rest of the app can react (e.g. start analytics only after consent).
 *
 * Withdrawal: when consent is already set, render a floating
 * "Configurar cookies" pill in the bottom-right corner so the user
 * can re-open the dialog at any time, as required by LSSI Art. 22.2
 * ("el usuario debe poder denegar el tratamiento de forma sencilla").
 */

type Consent = {
  necessary: true;
  preferences: boolean;
  analytics: boolean;
  marketing: boolean;
  decidedAt: string; // ISO timestamp of the last decision
};

const STORAGE_KEY = "kira-cookie-consent-v2";
const CONSENT_EVENT = "kira:consent-changed";

function readStoredConsent(): Consent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      necessary: true,
      preferences: !!parsed.preferences,
      analytics: !!parsed.analytics,
      marketing: !!parsed.marketing,
      decidedAt: parsed.decidedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function persist(consent: Consent): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(consent));
  try {
    window.dispatchEvent(
      new CustomEvent(CONSENT_EVENT, { detail: consent }),
    );
  } catch {
    /* CustomEvent not available — analytics will not auto-start. */
  }
}

type BannerMode = "loading" | "hidden" | "first-visit" | "configure";

export default function CookieBanner() {
  // Start as "loading" so the first paint is a no-op. This avoids a
  // visible flicker of the floating pill on first-visit (where the
  // pill would otherwise briefly appear before useEffect flips the
  // mode to "first-visit" and replaces it with the full dialog).
  const [mode, setMode] = useState<BannerMode>("loading");
  const [prefs, setPrefs] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    const stored = readStoredConsent();
    if (!stored) {
      setMode("first-visit");
      return;
    }
    setPrefs(stored.preferences);
    setAnalytics(stored.analytics);
    setMarketing(stored.marketing);
    setMode("hidden");
  }, []);

  function acceptAll() {
    persist({
      necessary: true,
      preferences: true,
      analytics: true,
      marketing: true,
      decidedAt: new Date().toISOString(),
    });
    setMode("hidden");
  }

  function rejectAll() {
    persist({
      necessary: true,
      preferences: false,
      analytics: false,
      marketing: false,
      decidedAt: new Date().toISOString(),
    });
    setMode("hidden");
  }

  function savePreferences() {
    persist({
      necessary: true,
      preferences: prefs,
      analytics: analytics,
      marketing: marketing,
      decidedAt: new Date().toISOString(),
    });
    setMode("hidden");
  }

  // While we're reading localStorage on the client, render nothing.
  if (mode === "loading") return null;

  // Floating pill — visible whenever consent has already been given,
  // so the user can withdraw without hunting for a link.
  if (mode === "hidden" || mode === "configure") {
    return (
      <>
        {mode === "configure" && (
          <Dialog
            prefs={prefs}
            analytics={analytics}
            marketing={marketing}
            setPrefs={setPrefs}
            setAnalytics={setAnalytics}
            setMarketing={setMarketing}
            onAccept={acceptAll}
            onReject={rejectAll}
            onSave={savePreferences}
            onClose={() => setMode("hidden")}
          />
        )}
        <button
          type="button"
          onClick={() => setMode("configure")}
          aria-label="Configurar cookies"
          title="Configurar cookies"
          style={{
            position: "fixed",
            bottom: 16,
            right: 16,
            zIndex: 50,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 36,
            height: 36,
            padding: 0,
            background: "#1e293b",
            color: "#fff",
            border: "none",
            borderRadius: 999,
            fontSize: 18,
            lineHeight: 1,
            cursor: "pointer",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          }}
        >
          <span aria-hidden="true">🍪</span>
        </button>
      </>
    );
  }

  return (
    <Dialog
      prefs={prefs}
      analytics={analytics}
      marketing={marketing}
      setPrefs={setPrefs}
      setAnalytics={setAnalytics}
      setMarketing={setMarketing}
      onAccept={acceptAll}
      onReject={rejectAll}
      onSave={savePreferences}
      onClose={() => setMode("hidden")}
    />
  );
}

function Dialog(props: {
  prefs: boolean;
  analytics: boolean;
  marketing: boolean;
  setPrefs: (v: boolean) => void;
  setAnalytics: (v: boolean) => void;
  setMarketing: (v: boolean) => void;
  onAccept: () => void;
  onReject: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const {
    prefs,
    analytics,
    marketing,
    setPrefs,
    setAnalytics,
    setMarketing,
    onAccept,
    onReject,
    onSave,
    onClose,
  } = props;

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Consentimiento de cookies"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 60,
        background: "#fff",
        borderTop: "1px solid #e5e7eb",
        boxShadow: "0 -4px 12px rgba(0,0,0,0.06)",
        padding: "16px 24px",
      }}
    >
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 8,
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
            Usamos cookies
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              background: "transparent",
              border: "none",
              fontSize: 18,
              cursor: "pointer",
              color: "#64748b",
            }}
          >
            ×
          </button>
        </div>
        <p style={{ fontSize: 13, color: "#475569", marginBottom: 12 }}>
          Utilizamos cookies propias y de terceros para asegurar el
          correcto funcionamiento del sitio y, con tu consentimiento,
          para medir el tráfico y mostrar contenido relevante. Puedes
          aceptar todas las cookies, rechazar las no esenciales o
          configurar tus preferencias por categoría, conforme al{" "}
          <strong>Art. 22.2 de la LSSI</strong> y al RGPD. Más
          información en nuestra{" "}
          <a
            href="/legal/privacy"
            style={{ textDecoration: "underline" }}
          >
            política de privacidad
          </a>
          .
        </p>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            marginBottom: 12,
          }}
        >
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked disabled /> <strong>Necesarias</strong>{" "}
            (sesión, autenticación, CSRF)
          </label>
          <label style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={prefs}
              onChange={(e) => setPrefs(e.target.checked)}
            />{" "}
            Preferencias (idioma, tema)
          </label>
          <label style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={analytics}
              onChange={(e) => setAnalytics(e.target.checked)}
            />{" "}
            Analítica (páginas vistas, errores)
          </label>
          <label style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={marketing}
              onChange={(e) => setMarketing(e.target.checked)}
            />{" "}
            Marketing (píxeles de adquisición)
          </label>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button
            type="button"
            onClick={onSave}
            style={{
              padding: "6px 12px",
              border: "1px solid #d1d5db",
              borderRadius: 4,
              background: "#fff",
              cursor: "pointer",
            }}
          >
            Guardar preferencias
          </button>
          <button
            type="button"
            onClick={onAccept}
            style={{
              padding: "6px 12px",
              border: "none",
              borderRadius: 4,
              background: "#4f46e5",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Aceptar todo
          </button>
          <button
            type="button"
            onClick={onReject}
            style={{
              padding: "6px 12px",
              border: "1px solid #d1d5db",
              borderRadius: 4,
              background: "#fff",
              cursor: "pointer",
            }}
          >
            Rechazar no esenciales
          </button>
        </div>
      </div>
    </div>
  );
}