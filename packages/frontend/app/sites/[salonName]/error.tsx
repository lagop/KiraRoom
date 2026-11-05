"use client";

import { useEffect } from "react";
import { Store } from "lucide-react";
import { translatorFor } from "@/lib/use-translation";

/**
 * When the salon's page cannot be built (the API did not answer and there is
 * no cached copy), the visitor saw Next's "Application error: a server-side
 * exception has occurred", in English. The page data is what failed, so the
 * salon's phone is not known here; a retry is what can help.
 */
export default function SalonPageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // The page data is what failed, so its language is not known: Spanish,
  // never the visitor's panel language.
  const t = translatorFor("es");
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 via-white to-pink-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center">
        <div className="mx-auto w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mb-4">
          <Store className="w-8 h-8 text-purple-600" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">{t("sites.error.title")}</h1>
        <p className="text-gray-600">{t("sites.error.description")}</p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 rounded-lg bg-purple-600 px-6 py-3 font-medium text-white hover:bg-purple-700"
        >
          {t("sites.error.retry")}
        </button>
      </div>
    </div>
  );
}
