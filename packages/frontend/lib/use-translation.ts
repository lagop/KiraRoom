"use client";

import { useEffect, useState } from "react";
import apiClient from "./api";

// Import translation files directly
import esTranslations from "../messages/es.json";
import enTranslations from "../messages/en.json";

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
        // First check localStorage for user preference
        const savedLanguage = localStorage.getItem("kira_language");
        if (savedLanguage && ["es", "en"].includes(savedLanguage)) {
          setLanguage(savedLanguage);
          return;
        }

        // Try to get tenant settings from API
        const tenant = await apiClient.getTenant();
        const tenantLang = tenant.language || "es";
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
        // First check localStorage for user preference
        const savedLanguage = localStorage.getItem("kira_language");
        if (savedLanguage && ["es", "en"].includes(savedLanguage)) {
          setTenantLanguage(savedLanguage);
          setIsLoading(false);
          return;
        }

        // Try to get tenant settings from API
        const tenant = await apiClient.getTenant();
        setTenantLanguage(tenant.language || "es");
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
