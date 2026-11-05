"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import apiClient, { ApiError, setToken, removeRefreshToken, isTwoFactorRequired } from "@/lib/api";
import { CAPTCHA_REQUIRED_CODE } from "@/lib/signup-form";
import { TurnstileWidget, isTurnstileConfigured } from "@/src/components/auth/turnstile-widget";
import { TwoFactorStep } from "@/src/components/auth/two-factor-step";
import { useTranslations } from "@/lib/use-translation";
import { LanguageSwitcher } from "@/app/dashboard/components/language-switcher";
import { AlertCircle } from "lucide-react";
import { authStorage, endSupportTab, startSupportTab, updateSupportTab } from "@/lib/auth-storage";

function LoginPageContent() {
  const t = useTranslations();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isLaunchMode, setIsLaunchMode] = useState(false);
  const [launchInfo, setLaunchInfo] = useState<{ tenantName: string; ownerName: string } | null>(null);
  // Set when the account has two-step verification: the code step replaces the form.
  const [challenge, setChallenge] = useState<string | null>(null);
  // After 3 failed sign-ins the server asks for the captcha (CAPTCHA_REQUIRED).
  const [captchaNeeded, setCaptchaNeeded] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (typeof window === "undefined") return;
    // A support tab whose session ended (2-hour cap, or the console signed
    // out everywhere) lands here: say so instead of a bare login form.
    if (searchParams?.get("support_ended") === "1") {
      setError(t("login.support_ended"));
      return;
    }

    // Support entry from the console (audit 8, C10/C17): a NEW tab opened at
    // /login#support=<token>&tenant=<id>&name=<salon>&owner=<name>. The token
    // is in the fragment, so it reaches neither the server's logs nor the
    // Referer, and it is wiped from the address bar at once. It is consumed
    // via POST /auth/impersonate (one-shot, 60 s, with the reason signed in
    // it by the console), which mints the support session and its own cookie.
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = hash.get("support");
    const tenantId = hash.get("tenant");
    if (!token || !tenantId) return;
    const tenantName = hash.get("name") || "";
    const ownerName = hash.get("owner") || "";
    window.history.replaceState(null, "", window.location.pathname);

    // This tab keeps its session apart from the console's (sessionStorage):
    // the console stays signed in, in this browser and its other tabs.
    startSupportTab({ tenantId, tenantName });
    setIsLaunchMode(true);
    setLaunchInfo({ tenantName: tenantName || tenantId, ownerName });
    setLoading(true);
    apiClient
      .impersonate(token)
      .then((response) => {
        updateSupportTab({ endsAt: response.support?.endsAt });
        setToken(response.tokens.accessToken);
        // The refresh token is the httpOnly cookie the response set.
        removeRefreshToken();
        authStorage().setItem("user", JSON.stringify(response.user));
        window.location.href = "/dashboard";
      })
      .catch((err) => {
        endSupportTab();
        setError(t("login.failed_to_launch", { message: err.message }));
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const signedIn = (response: { accessToken: string; user: unknown }) => {
    setToken(response.accessToken);
    if (typeof window !== "undefined") {
      authStorage().setItem("user", JSON.stringify(response.user));
    }
    router.push("/dashboard");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await apiClient.login(email, password, undefined, captchaToken ?? undefined);
      if (isTwoFactorRequired(response)) {
        setChallenge(response.challenge);
        return;
      }
      signedIn(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.error"));
      if (err instanceof ApiError && err.code === CAPTCHA_REQUIRED_CODE && isTurnstileConfigured()) {
        setCaptchaNeeded(true);
      }
      // A token works once: a fresh challenge for the next try.
      if (captchaToken) {
        setCaptchaToken(null);
        setCaptchaReset((n) => n + 1);
      }
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

          {challenge ? (
            <TwoFactorStep
              challenge={challenge}
              onSignedIn={signedIn}
              onCancel={() => {
                setChallenge(null);
                setPassword("");
              }}
            />
          ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-sm font-medium text-gray-700 mb-1">
                {t("login.email")}
              </label>
              <input
                id="login-email"
                autoComplete="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                required
              />
            </div>

            <div>
              <div className="flex items-baseline justify-between mb-1">
                <label htmlFor="login-password" className="block text-sm font-medium text-gray-700">
                  {t("login.password")}
                </label>
                <a href="/forgot-password" className="text-xs text-purple-600 hover:underline">
                  {t("login.forgot_password")}
                </a>
              </div>
              <input
                id="login-password"
                autoComplete="current-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                required
              />
            </div>

            {captchaNeeded && (
              <TurnstileWidget onToken={setCaptchaToken} resetKey={captchaReset} action="login" />
            )}

            <button
              type="submit"
              disabled={loading || (captchaNeeded && !captchaToken)}
              className="w-full bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700 disabled:opacity-50"
            >
              {loading ? t("login.logging_in") : t("login.login")}
            </button>
          </form>
          )}

          {/* This used to be the bare question with nowhere to go: the
              sign-up page links back here, but not the other way round, so
              anyone landing on the login form was at a dead end. */}
          <p className="text-sm text-gray-500 mt-8">
            {t("login.no_account")}{" "}
            <a
              href="/signup"
              className="text-purple-600 font-medium hover:underline"
            >
              {t("login.create_account")}
            </a>
          </p>

          <p className="text-xs text-gray-400 mt-4 space-x-3">
            <a href="/legal/privacy" className="hover:underline">Privacidad</a>
            <span>·</span>
            <a href="/legal/terms" className="hover:underline">Términos</a>
            <span>·</span>
            <a href="/legal/aviso-legal" className="hover:underline">Aviso legal</a>
          </p>
        </div>
      </div>
    </div>
  );
}

// useSearchParams() needs a Suspense boundary for the page to prerender
// (required since Next.js 14.1; 14.0 let it through).
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}
