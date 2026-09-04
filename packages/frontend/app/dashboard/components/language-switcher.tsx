"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "@/lib/use-translation";

export function LanguageSwitcher() {
  const t = useTranslations();
  const [currentLang, setCurrentLang] = useState("es");

  useEffect(() => {
    // Get initial language from localStorage
    const getCurrentLanguage = () => {
      if (typeof window !== "undefined") {
        const savedLanguage = localStorage.getItem("kira_language");
        if (savedLanguage && ["es", "en"].includes(savedLanguage)) {
          return savedLanguage;
        }
      }
      return "es"; // Default fallback
    };

    setCurrentLang(getCurrentLanguage());

    // Listen for storage changes (in case language is changed from another tab/window)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "kira_language" && e.newValue) {
        setCurrentLang(e.newValue);
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const handleLanguageChange = (lang: string) => {
    // Update localStorage and state
    if (typeof window !== "undefined") {
      localStorage.setItem("kira_language", lang);
      setCurrentLang(lang);
      window.location.reload();
    }
  };

  return (
    <div className="flex items-center space-x-1 flex-shrink-0">
      <button
        onClick={() => handleLanguageChange("en")}
        className={`px-1.5 sm:px-2 py-1 text-xs font-medium rounded ${
          currentLang === "en"
            ? "bg-blue-100 text-blue-800"
            : "text-gray-500 hover:text-gray-700"
        }`}
      >
        EN
      </button>
      <button
        onClick={() => handleLanguageChange("es")}
        className={`px-1.5 sm:px-2 py-1 text-xs font-medium rounded ${
          currentLang === "es"
            ? "bg-blue-100 text-blue-800"
            : "text-gray-500 hover:text-gray-700"
        }`}
      >
        ES
      </button>
    </div>
  );
}
