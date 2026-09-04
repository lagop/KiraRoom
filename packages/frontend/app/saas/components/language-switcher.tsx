"use client";

import { useState, useEffect } from "react";

export function LanguageSwitcher() {
  const [currentLang, setCurrentLang] = useState("es");

  useEffect(() => {
    const getCurrentLanguage = () => {
      if (typeof window !== "undefined") {
        const savedLanguage = localStorage.getItem("kira_language");
        if (savedLanguage && ["es", "en"].includes(savedLanguage)) {
          return savedLanguage;
        }
      }
      return "es";
    };

    setCurrentLang(getCurrentLanguage());

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "kira_language" && e.newValue) {
        setCurrentLang(e.newValue);
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const handleLanguageChange = (lang: string) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("kira_language", lang);
      setCurrentLang(lang);
      window.location.reload();
    }
  };

  return (
    <div className="flex items-center space-x-2">
      <button
        onClick={() => handleLanguageChange("en")}
        className={`px-2 py-1 text-xs font-medium rounded ${
          currentLang === "en"
            ? "bg-slate-700 text-white"
            : "text-slate-400 hover:text-white"
        }`}
      >
        EN
      </button>
      <button
        onClick={() => handleLanguageChange("es")}
        className={`px-2 py-1 text-xs font-medium rounded ${
          currentLang === "es"
            ? "bg-slate-700 text-white"
            : "text-slate-400 hover:text-white"
        }`}
      >
        ES
      </button>
    </div>
  );
}