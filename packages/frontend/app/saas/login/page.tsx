"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import apiClient, { setToken } from "@/lib/api";
import { LanguageSwitcher } from "../components/language-switcher";
import { Building2, BarChart2, Users, Shield } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";

export default function SaasLoginPage() {
  const t = useTranslations();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await apiClient.login(email, password);

      if (response.user.role !== "saas_owner") {
        setError(t("saas.access_denied"));
        setLoading(false);
        return;
      }

      setToken(response.accessToken);
      if (typeof window !== "undefined") {
        localStorage.setItem("user", JSON.stringify(response.user));
        // Set cookie for middleware to detect SaaS user
        document.cookie = "saas_user=true; path=/; max-age=" + (7 * 24 * 60 * 60);
      }
      router.push("/saas");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saas.login_failed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Left side - Branding */}
      <div className="hidden md:flex md:w-1/2 bg-slate-900 flex-col justify-center px-12 text-white">
        <div className="max-w-lg">
          <div className="flex items-center mb-6">
            <div className="bg-slate-800 p-3 rounded-lg mr-4">
              <Shield className="w-8 h-8 text-blue-400" />
            </div>
            <h1 className="text-3xl font-bold">KiraSaaS</h1>
          </div>
          <p className="text-slate-400 mb-12">
            {t("saas.loginSubtitle")}
          </p>

          <div className="space-y-6">
            <div className="flex items-center">
              <div className="bg-slate-800 p-3 rounded-full mr-4">
                <Building2 className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h3 className="font-medium">{t("saas.feature_salons_title")}</h3>
                <p className="text-sm text-slate-400">
                  {t("saas.feature_salons_desc")}
                </p>
              </div>
            </div>

            <div className="flex items-center">
              <div className="bg-slate-800 p-3 rounded-full mr-4">
                <BarChart2 className="w-5 h-5 text-indigo-400" />
              </div>
              <div>
                <h3 className="font-medium">{t("saas.feature_analytics_title")}</h3>
                <p className="text-sm text-slate-400">
                  {t("saas.feature_analytics_desc")}
                </p>
              </div>
            </div>

            <div className="flex items-center">
              <div className="bg-slate-800 p-3 rounded-full mr-4">
                <Users className="w-5 h-5 text-purple-400" />
              </div>
              <div>
                <h3 className="font-medium">{t("saas.feature_users_title")}</h3>
                <p className="text-sm text-slate-400">
                  {t("saas.feature_users_desc")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Right side - Login Form */}
      <div className="w-full md:w-1/2 flex items-center justify-center p-8 bg-white relative">
        {/* Language Switcher */}
        <div className="absolute top-4 right-4">
          <LanguageSwitcher />
        </div>

        <div className="w-full max-w-md">
          <div className="md:hidden flex items-center justify-center mb-8">
            <div className="bg-slate-900 p-3 rounded-lg mr-3">
              <Shield className="w-6 h-6 text-blue-400" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">KiraSaaS</h1>
          </div>

          <div className="text-center md:text-left mb-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-2">
              {t("saas.login_title")}
            </h2>
            <p className="text-gray-500">
              {t("saas.login_subtitle")}
            </p>
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-4">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.email_label")}
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.password_label")}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-slate-500"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-slate-900 text-white py-2 px-4 rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              {loading ? t("saas.signing_in") : t("saas.sign_in")}
            </button>
          </form>

          <p className="text-sm text-gray-500 mt-6 text-center">
            {t("saas.restricted_area")}
          </p>
        </div>
      </div>
    </div>
  );
}