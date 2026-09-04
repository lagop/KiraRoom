/* eslint-disable */
/**
 * Vanilla-JS cookie consent banner for the KiraStudio marketing site.
 *
 * Loaded as `marketing/public/cookie-banner.js` via a deferred
 * <script> tag in BaseLayout.astro. Why vanilla (and not React):
 *
 *   - Marketing site is zero-JS by design (Sprint 2.4). Pulling in
 *     React for one component breaks the bundle-weight promise.
 *   - The frontend's React cookie banner (`packages/frontend/app/components/
 *     cookie-banner.tsx`) renders client-side only; it can't render
 *     inside an Astro static page.
 *   - The contract must match the frontend's so behaviour stays
 *     consistent if the user lands on both sites in one session.
 *
 * Behaviour mirrors the frontend component:
 *   - 4 categories (necessary always-on; preferences, analytics,
 *     marketing opt-in)
 *   - First visit → full bottom dialog
 *   - Subsequent visits → floating "🍪 Configurar" pill
 *   - Persisted to localStorage under `kira-cookie-consent-v2`
 *   - LSSI Art. 22.2 wording: "rechazar las no esenciales" CTA
 *   - Dispatch CustomEvent `kirastudio:consent-changed` so the
 *     Cloudflare Web Analytics beacon (added in BaseLayout) can be
 *     lazily activated only after consent
 *
 * No deps. ~3 KB unminified.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "kira-cookie-consent-v2";
  var CONSENT_EVENT = "kirastudio:consent-changed";
  var EMAIL_DOMAIN = (window.KIRA_EMAIL_DOMAIN || "kirastudio.com");
  var PREF_URL =
    (window.KIRA_PREF_URL || "https://app.kirastudio.com/dashboard/settings/notifications");

  function readConsent() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return {
        necessary: true,
        preferences: !!parsed.preferences,
        analytics: !!parsed.analytics,
        marketing: !!parsed.marketing,
        decidedAt: parsed.decidedAt || new Date().toISOString(),
      };
    } catch (e) {
      return null;
    }
  }

  function persist(consent, reload) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(consent));
      window.dispatchEvent(
        new CustomEvent(CONSENT_EVENT, { detail: consent }),
      );
    } catch (e) {
      /* localStorage unavailable — accept silently */
    }
    if (reload) {
      // Lightweight reload so analytics scripts that already gated on
      // `localStorage["kira-cookie-consent-v2"]` boot fresh.
      location.reload();
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildDialog(state) {
    var isOpen = state.mode === "open";
    var wrap = document.createElement("div");
    wrap.className = "cb-dialog";
    if (!isOpen) wrap.style.display = "none";

    wrap.innerHTML =
      '<div class="cb-dialog__head">' +
      '  <span class="cb-dialog__title">🍪 Usamos cookies</span>' +
      '  <button type="button" class="cb-dialog__close" aria-label="Cerrar">×</button>' +
      '</div>' +
      '<p style="margin:0 0 8px;">Utilizamos cookies propias y de terceros para asegurar el correcto funcionamiento del sitio y, con tu consentimiento, para medir el tráfico y mostrar contenido relevante. Puedes aceptar todas las cookies, rechazar las no esenciales, o configurar tus preferencias por categoría, conforme al <strong>Art. 22.2 de la LSSI</strong> y al RGPD. Más información en nuestra <a href="/privacy">política de privacidad</a>.</p>' +
      '<div class="cb-dialog__categories">' +
      '  <label><input type="checkbox" checked disabled> <strong>Necesarias</strong> (sesión)</label>' +
      '  <label><input type="checkbox" id="cb-pref"' +
      (state.prefs ? " checked" : "") +
      '> Preferencias</label>' +
      '  <label><input type="checkbox" id="cb-analytics"' +
      (state.analytics ? " checked" : "") +
      '> Analítica</label>' +
      '  <label><input type="checkbox" id="cb-marketing"' +
      (state.marketing ? " checked" : "") +
      '> Marketing</label>' +
      '</div>' +
      '<div class="cb-dialog__actions">' +
      '  <button type="button" class="btn btn-secondary" data-cb-action="save">Guardar preferencias</button>' +
      '  <button type="button" class="btn btn-primary" data-cb-action="accept">Aceptar todo</button>' +
      '  <button type="button" class="btn btn-secondary" data-cb-action="reject">Rechazar no esenciales</button>' +
      '</div>';

    return wrap;
  }

  function buildPill(onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-pill";
    btn.textContent = "🍪 Configurar cookies";
    btn.setAttribute("aria-label", "Configurar cookies");
    btn.addEventListener("click", onClick);
    return btn;
  }

  function mount(initialConsent) {
    var root = document.getElementById("cookie-banner-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "cookie-banner-root";
      document.body.appendChild(root);
    }

    var state = {
      mode: initialConsent ? "configured" : "open",
      prefs: !!(initialConsent && initialConsent.preferences),
      analytics: !!(initialConsent && initialConsent.analytics),
      marketing: !!(initialConsent && initialConsent.marketing),
    };

    var dialog = buildDialog(state);
    var pill = buildPill(function () {
      state.mode = "open";
      dialog.style.display = "";
    });

    function readInputs() {
      state.prefs = !!dialog.querySelector("#cb-pref").checked;
      state.analytics = !!dialog.querySelector("#cb-analytics").checked;
      state.marketing = !!dialog.querySelector("#cb-marketing").checked;
    }

    dialog.querySelector(".cb-dialog__close").addEventListener(
      "click",
      function () {
        // Close without saving = keep existing consent (or show pill if none).
        state.mode = initialConsent ? "configured" : "configured";
        dialog.style.display = "none";
      }
    );

    dialog.querySelectorAll("[data-cb-action]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var action = btn.getAttribute("data-cb-action");
        if (action === "accept") {
          state.prefs = true;
          state.analytics = true;
          state.marketing = true;
        } else if (action === "reject") {
          state.prefs = false;
          state.analytics = false;
          state.marketing = false;
        } else {
          readInputs();
        }
        persist(
          {
            necessary: true,
            preferences: state.prefs,
            analytics: state.analytics,
            marketing: state.marketing,
            decidedAt: new Date().toISOString(),
          },
          true
        );
      });
    });

    if (state.mode === "open") {
      root.appendChild(dialog);
    }
    root.appendChild(pill);
  }

  // Defer one tick so the parser can finish before we read
  // `document.body`. The script tag itself has `defer`, but we also
  // tolerate being injected by a router or other script.
  function start() {
    var existing = readConsent();
    mount(existing);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();