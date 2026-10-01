"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

/**
 * Asks for a password reset link. The answer is the same whether or not the
 * address has an account, so the page never says which. From a salon's site
 * the link carries ?salon=<slug>, limiting the reset to that salon's account.
 */
export default function ForgotPasswordPage() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const salon = searchParams?.get("salon") || undefined;
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await apiClient.forgotPassword(email.trim(), salon);
      setSent(true);
    } catch {
      setError(t("password_reset.error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">{t("password_reset.title")}</h1>

        {sent ? (
          <div className="mt-4 bg-green-50 text-green-800 p-4 rounded-lg flex gap-2" role="status">
            <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{t("password_reset.sent")}</p>
          </div>
        ) : (
          <>
            <p className="text-gray-500 mb-6 text-sm">{t("password_reset.intro")}</p>
            {error && (
              <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 flex items-center text-sm" role="alert">
                <AlertCircle className="w-5 h-5 mr-2" />
                {error}
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="reset-email" className="block text-sm font-medium text-gray-700 mb-1">
                  {t("login.email")}
                </label>
                <input
                  id="reset-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700 disabled:opacity-50"
              >
                {loading ? t("password_reset.sending") : t("password_reset.send")}
              </button>
            </form>
          </>
        )}

        <p className="text-sm mt-6">
          <a href={salon ? `/sites/${encodeURIComponent(salon)}` : "/login"} className="text-purple-600 hover:underline">
            {t("password_reset.back_to_login")}
          </a>
        </p>
      </div>
    </div>
  );
}
