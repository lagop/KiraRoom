"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import apiClient, { setToken, setRefreshToken } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { LanguageSwitcher } from "@/app/dashboard/components/language-switcher";
import { AlertCircle } from "lucide-react";

export default function LoginPage() {
  const t = useTranslations();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isLaunchMode, setIsLaunchMode] = useState(false);
  const [launchInfo, setLaunchInfo] = useState<{ tenantName: string; ownerName: string } | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!searchParams) return;
    const asOwner = searchParams.get("as_owner");
    const token = searchParams.get("token");
    const ownerName = searchParams.get("owner");

    // Impersonation entry: the SaaS panel always sends BOTH `as_owner`
    // and `token` (see app/saas/tenants/page.tsx → onClick handler).
    // We consume the token via POST /auth/impersonate, which mints a
    // real session as the tenant owner and writes an AuditLog row.
    //
    // The previous version had a fallback that pre-filled the email
    // via launchSalonDashboard if only `as_owner` was present. That
    // branch was unreachable in normal use (the SaaS panel always
    // sends both) and leaked the owner's email to anyone who knew
    // a tenant id, so it has been removed.
    if (!asOwner || !token) return;

    setIsLaunchMode(true);
    setLaunchInfo({ tenantName: asOwner, ownerName: ownerName || "" });
    setLoading(true);
    apiClient
      .impersonate(token)
      .then((response) => {
        setToken(response.tokens.accessToken);
        setRefreshToken(response.tokens.refreshToken);
        if (typeof window !== "undefined") {
          localStorage.setItem("user", JSON.stringify(response.user));
        }
        // Force a clean navigation with the impersonation flag so the
        // tenant dashboard can show its "you are being impersonated"
        // banner.
        window.location.href = "/dashboard?impersonated=1";
      })
      .catch((err) => {
        setError(t("login.failed_to_launch", { message: err.message }));
        setLoading(false);
      });
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await apiClient.login(email, password);
      setToken(response.accessToken);
      if (typeof window !== "undefined") {
        localStorage.setItem("user", JSON.stringify(response.user));
      }
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Left side - Branding */}
      <div className="hidden md:flex md:w-1/2 bg-purple-600 flex-col justify-center px-12 text-white">
        <div className="max-w-lg">
          <h1 className="text-4xl font-bold mb-6">{t("login.title")}</h1>
          <p className="text-lg text-purple-100 mb-12">
            {t("login.description")}
          </p>

          <div className="space-y-6">
            <div className="flex items-center">
              <div className="bg-purple-500/30 p-3 rounded-full mr-4">
                <span className="text-xl">📅</span>
              </div>
              <div>
                <h3 className="font-medium">
                  {t("login.features.appointment_booking.title")}
                </h3>
                <p className="text-sm text-purple-100">
                  {t("login.features.appointment_booking.description")}
                </p>
              </div>
            </div>

            <div className="flex items-center">
              <div className="bg-purple-500/30 p-3 rounded-full mr-4">
                <span className="text-xl">👥</span>
              </div>
              <div>
                <h3 className="font-medium">
                  {t("login.features.client_management.title")}
                </h3>
                <p className="text-sm text-purple-100">
                  {t("login.features.client_management.description")}
                </p>
              </div>
            </div>

            <div className="flex items-center">
              <div className="bg-purple-500/30 p-3 rounded-full mr-4">
                <span className="text-xl">💈</span>
              </div>
              <div>
                <h3 className="font-medium">
                  {t("login.features.professional_tools.title")}
                </h3>
                <p className="text-sm text-purple-100">
                  {t("login.features.professional_tools.description")}
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
          <div className="text-center md:text-left mb-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-2">
              {t("login.welcome_back")}
            </h2>
            <p className="text-gray-500">{t("login.sign_in_prompt")}</p>
          </div>

          {error && (
            <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-4 flex items-center">
              <AlertCircle className="w-5 h-5 mr-2" />
              {error}
            </div>
          )}

          {isLaunchMode && launchInfo && (
            <div className="bg-indigo-50 text-indigo-700 p-4 rounded-lg mb-4">
              <p className="font-medium">{t("login.launching")}</p>
              <p className="text-sm">{t("login.logging_in_as_owner", { tenant: launchInfo.tenantName })}</p>
              <p className="text-xs text-indigo-600 mt-1">{t("login.owner_label", { name: launchInfo.ownerName })}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("login.email")}
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("login.password")}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700 disabled:opacity-50"
            >
              {loading ? t("login.logging_in") : t("login.login")}
            </button>
          </form>

          <p className="text-sm text-gray-500 mt-8">{t("login.no_account")}</p>

          <p className="text-xs text-gray-400 mt-4 space-x-3">
            <a href="/legal/privacy" className="hover:underline">Privacidad</a>
            <span>·</span>
            <a href="/legal/terms" className="hover:underline">Términos</a>
          </p>
        </div>
      </div>
    </div>
  );
}
