"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

/**
 * Sets a new password with the token from the reset email
 * (/reset-password?token=...). A successful change signs out every session.
 */
export default function ResetPasswordPage() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const token = searchParams?.get("token") || "";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) return setError(t("password_reset.too_short"));
    if (password !== confirm) return setError(t("password_reset.mismatch"));
    setLoading(true);
    try {
      await apiClient.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      // The server explains an invalid or expired link in Spanish.
      setError(err instanceof Error && err.message ? err.message : t("password_reset.error"));
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    "w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500";

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">{t("password_reset.new_title")}</h1>

        {!token ? (
          <p className="text-sm text-gray-600">
            {t("password_reset.missing_token")}{" "}
            <a href="/forgot-password" className="text-purple-600 hover:underline">
              {t("password_reset.request_new")}
            </a>
          </p>
        ) : done ? (
          <div className="bg-green-50 text-green-800 p-4 rounded-lg flex gap-2" role="status">
            <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p className="text-sm">{t("password_reset.done")}</p>
          </div>
        ) : (
          <>
            {error && (
              <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 flex items-center text-sm" role="alert">
                <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0" />
                <span>
                  {error}{" "}
                  <a href="/forgot-password" className="underline">
                    {t("password_reset.request_new")}
                  </a>
                </span>
              </div>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="new-password" className="block text-sm font-medium text-gray-700 mb-1">
                  {t("password_reset.new_password")}
                </label>
                <input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                  required
                />
              </div>
              <div>
                <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700 mb-1">
                  {t("password_reset.confirm")}
                </label>
                <input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className={inputClass}
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700 disabled:opacity-50"
              >
                {loading ? t("password_reset.saving") : t("password_reset.save")}
              </button>
            </form>
          </>
        )}

        <p className="text-sm mt-6">
          <a href="/login" className="text-purple-600 hover:underline">
            {t("password_reset.back_to_login")}
          </a>
        </p>
      </div>
    </div>
  );
}
