"use client";

import { useEffect, useState } from "react";
import apiClient, { getToken } from "./api";

// Import translation files directly
import esTranslations from "../messages/es.json";
import enTranslations from "../messages/en.json";

/**
 * Which source should supply the UI language, without doing any I/O.
 *
 * Both hooks below used to call the authenticated `GET /auth/tenant`
 * whenever localStorage held no `kira_language`. On a public page -- the
 * login form uses `useTranslations()` -- there is no session, so that call
 * answers 401, and api.ts's 401 handler navigates to /login. From /login
 * that is a reload, and the page refreshed forever.
 *
 * So the language preference of a logged-out visitor is not worth a request
 * that cannot succeed. Asking for a token first is both the fix and the
 * honest description of the dependency.
 *
 * Extracted as a pure function because the bug lived in the branching, not
 * in the fetch.
 */
export type LanguageSource =
  | { kind: "saved"; language: string }
  | { kind: "fetch" }
  | { kind: "default" };

export const SUPPORTED_LANGUAGES = ["es", "en"];
export const DEFAULT_LANGUAGE = "es";

export function resolveLanguageSource(
  saved: string | null,
  hasToken: boolean,
): LanguageSource {
  if (saved && SUPPORTED_LANGUAGES.includes(saved)) {
    return { kind: "saved", language: saved };
  }
  // No session: the tenant endpoint would 401, and a 401 on a public page is
  // what caused the login reload loop.
  if (!hasToken) return { kind: "default" };
  return { kind: "fetch" };
}

type Translations = Record<string, any>;

const translations: Record<string, Translations> = {
  es: esTranslations,
  en: enTranslations,
};

// Simple translation function
function getTranslation(
  language: string,
  key: string,
  params?: Record<string, any>,
): string {
  const keys = key.split(".");
  let value: any = translations[language] ?? translations.es;

  for (const k of keys) {
    value = value?.[k];
    if (value === undefined) break;
  }

  if (typeof value !== "string") {
    return key; // Return key if translation not found
  }

  if (params) {
    return value.replace(/\{(\w+)\}/g, (_, param) =>
      String(params[param] ?? `{${param}}`),
    );
  }

  return value;
}

export function useTranslations() {
  // Initialize with localStorage value or default to "es"
  // For SSR consistency, always start with "es" and let client update after hydration
  const [language, setLanguage] = useState("es");

  useEffect(() => {
    const loadLanguage = async () => {
      try {
        const source = resolveLanguageSource(
          localStorage.getItem("kira_language"),
          Boolean(getToken()),
        );
        if (source.kind === "saved") {
          setLanguage(source.language);
          return;
        }
        if (source.kind === "default") {
          setLanguage(DEFAULT_LANGUAGE);
          return;
        }

        const tenant = await apiClient.getTenant();
        const tenantLang = tenant.language || DEFAULT_LANGUAGE;
        setLanguage(tenantLang);
        // Save to localStorage for future visits
        localStorage.setItem("kira_language", tenantLang);
      } catch (error) {
        console.warn("Could not load language, using default:", error);
        setLanguage("es");
      }
    };

    loadLanguage();
  }, []);

  const t = (key: string, params?: Record<string, any>) => {
    return getTranslation(language, key, params);
  };

  return t;
}

// Hook to get tenant language and provide translation function
export function useTenantTranslations() {
  const [tenantLanguage, setTenantLanguage] = useState("es");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadTenantLanguage = async () => {
      try {
        const source = resolveLanguageSource(
          localStorage.getItem("kira_language"),
          Boolean(getToken()),
        );
        if (source.kind === "saved") {
          setTenantLanguage(source.language);
          setIsLoading(false);
          return;
        }
        if (source.kind === "default") {
          setTenantLanguage(DEFAULT_LANGUAGE);
          setIsLoading(false);
          return;
        }

        const tenant = await apiClient.getTenant();
        setTenantLanguage(tenant.language || DEFAULT_LANGUAGE);
      } catch (error) {
        console.warn("Could not load tenant language, using default:", error);
        setTenantLanguage("es");
      } finally {
        setIsLoading(false);
      }
    };

    loadTenantLanguage();
  }, []);

  const translate = (key: string, params?: Record<string, any>) => {
    return getTranslation(tenantLanguage, key, params);
  };

  return {
    language: tenantLanguage,
    isLoading,
    t: translate,
    setLanguage: setTenantLanguage,
  };
}
