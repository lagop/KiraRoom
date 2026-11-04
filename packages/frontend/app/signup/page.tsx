"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, Loader2, Check, Eye, EyeOff, Globe } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import apiClient, { ApiError } from "@/lib/api";
import { rememberDesiredPlan } from "@/lib/desired-plan";
import { EMAIL_ALREADY_REGISTERED_CODE, salonWebPreview } from "@/lib/signup-form";
import { TurnstileWidget, isTurnstileConfigured } from "@/src/components/auth/turnstile-widget";

/** The browser's IANA zone, if it can tell. */
function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export default function SignupPage() {
  const router = useRouter();
  const t = useTranslations();
  const [salonName, setSalonName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // The panel exists in Spanish and English; the choice is saved as the
  // owner's and the salon's language.
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The address already has an account: the error links to sign-in and reset.
  const [emailTaken, setEmailTaken] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaReset, setCaptchaReset] = useState(0);
  // The plan picked on the website (/signup?plan=pro): Facturación highlights it later (B12).
  useEffect(() => rememberDesiredPlan(window.location.search), []);

  const webPreview = salonWebPreview(salonName);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailTaken(false);
    if (!acceptTerms) {
      setError(t("signup.termsRequired"));
      return;
    }
    if (password.length < 8) {
      setError(t("signup.passwordTooShort"));
      return;
    }
    if (isTurnstileConfigured() && !captchaToken) {
      setError(t("signup.captchaRequired"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.register({
        email: email.trim(),
        password,
        salonName: salonName.trim(),
        phone: phone.trim(),
        ownerName: ownerName.trim(),
        language,
        acceptTerms: true,
        // A first guess at the salon's zone; the server keeps it only when
        // it is one a salon can be in (Las Palmas signs up on Canary time).
        timezone: browserTimeZone(),
        ...(captchaToken && { turnstileToken: captchaToken }),
      });
      // apiClient.register stores both tokens, like login does. This used to
      // read res.accessToken — which register never returned — behind an
      // `if`, so it silently stored nothing and sent the new salon to a
      // dashboard it had no session for.
      if (!res?.accessToken) {
        throw new Error(t("signup.errorGeneric"));
      }
      try {
        // The panel opens in the language she chose.
        localStorage.setItem("kira_language", language);
      } catch {
        // Storage blocked: the panel reads the salon's language instead.
      }
      router.push("/dashboard");
    } catch (e: any) {
      if (e instanceof ApiError && e.code === EMAIL_ALREADY_REGISTERED_CODE) setEmailTaken(true);
      const msg = e?.message || t("signup.errorGeneric");
      setError(typeof msg === "string" ? msg : JSON.stringify(msg));
      // A Turnstile token works once: a new challenge for the next try.
      setCaptchaToken(null);
      setCaptchaReset((n) => n + 1);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="text-lg font-semibold text-gray-900">
          KiraRoom
        </Link>
        <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-700">
          {t("signup.badge")}
        </span>
      </header>

      <main className="mx-auto max-w-md px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900">{t("signup.title")}</h1>
        <p className="mt-1 text-sm text-gray-600">{t("signup.subtitle")}</p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-3">
          <div>
            <Field
              label={t("signup.fields.salon")}
              value={salonName}
              onChange={setSalonName}
              required
              maxLength={80}
              autoComplete="organization"
            />
            {/* Read-only for now: the address comes from the name. */}
            {webPreview && (
              <p className="mt-1 flex items-center gap-1 text-xs text-gray-500" aria-live="polite">
                <Globe className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                <span>
                  {t("signup.webPreview")} <strong className="font-medium text-gray-700">{webPreview}</strong>
                </span>
              </p>
            )}
          </div>
          <Field
            label={t("signup.fields.owner")}
            value={ownerName}
            onChange={setOwnerName}
            required
            maxLength={80}
            autoComplete="name"
          />
          <Field
            label={t("signup.fields.email")}
            value={email}
            onChange={setEmail}
            required
            maxLength={254}
            type="email"
            autoComplete="email"
          />
          <Field
            label={t("signup.fields.phone")}
            value={phone}
            onChange={setPhone}
            required
            maxLength={30}
            type="tel"
            autoComplete="tel"
          />
          <label className="block">
            <span className="text-xs font-medium text-gray-700">{t("signup.fields.password")}</span>
            <div className="relative mt-1">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                required
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
                className="block w-full rounded-md border border-gray-300 px-3 py-2 pr-10 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-500 hover:text-gray-700"
                aria-label={showPassword ? t("signup.hidePassword") : t("signup.showPassword")}
                title={showPassword ? t("signup.hidePassword") : t("signup.showPassword")}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </label>

          <label className="block">
            <span className="text-xs font-medium text-gray-700">{t("signup.fields.language")}</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as "es" | "en")}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            >
              <option value="es">{t("signup.languageEs")}</option>
              <option value="en">{t("signup.languageEn")}</option>
            </select>
          </label>

          <label className="flex items-start gap-2 pt-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={acceptTerms}
              onChange={(e) => setAcceptTerms(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
            />
            <span>
              {t("signup.termsBefore")}{" "}
              <a href="/legal/terms" target="_blank" rel="noopener noreferrer" className="text-violet-700 underline">
                {t("signup.termsLink")}
              </a>{" "}
              {t("signup.termsDpa")}{" "}
              <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-violet-700 underline">
                {t("signup.privacyLink")}
              </a>
              .
            </span>
          </label>

          <TurnstileWidget onToken={setCaptchaToken} resetKey={captchaReset} action="signup" />

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              <span>
                {error}
                {emailTaken && (
                  <>
                    {" "}
                    <Link href="/login" className="font-medium underline">
                      {t("signup.emailTakenLogin")}
                    </Link>
                    {" · "}
                    <Link href="/forgot-password" className="font-medium underline">
                      {t("signup.emailTakenReset")}
                    </Link>
                  </>
                )}
              </span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-violet-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("signup.submitting")}
              </>
            ) : (
              <>
                <Check className="h-4 w-4" />
                {t("signup.submit")}
              </>
            )}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-600">
          {t("signup.loginLink")}{" "}
          <Link
            href="/login"
            className="font-medium text-violet-600 hover:text-violet-700"
          >
            {t("signup.loginCta")}
          </Link>
        </p>
      </main>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  type = "text",
  autoComplete,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  autoComplete?: string;
  maxLength?: number;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-700">{label}</span>
      <input
        type={type}
        value={value}
        required={required}
        maxLength={maxLength}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
      />
    </label>
  );
}
