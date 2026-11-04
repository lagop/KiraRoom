"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, Loader2, Check, Eye, EyeOff, Globe } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import apiClient, { ApiError } from "@/lib/api";
import { rememberDesiredPlan } from "@/lib/desired-plan";
import {
  EMAIL_ALREADY_REGISTERED_CODE,
  SALON_WEB_BASE,
  WEB_ADDRESS_UNAVAILABLE_CODE,
  salonWebPreview,
  suggestedWebAddress,
  typedWebAddress,
} from "@/lib/signup-form";
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
  // D4: null = the address follows the name; a string = the one she typed.
  const [customSlug, setCustomSlug] = useState<string | null>(null);
  const [slugCheck, setSlugCheck] = useState<{ state: "idle" | "checking" | "ok" | "bad"; message: string }>({
    state: "idle",
    message: "",
  });
  useEffect(() => {
    if (customSlug === null) {
      setSlugCheck({ state: "idle", message: "" });
      return;
    }
    const slug = customSlug.replace(/-+$/, "");
    if (!slug) {
      setSlugCheck({ state: "idle", message: "" });
      return;
    }
    setSlugCheck({ state: "checking", message: "" });
    const timer = window.setTimeout(() => {
      apiClient
        .checkWebAddressForSignup(slug)
        .then((r) => setSlugCheck(r.available ? { state: "ok", message: "" } : { state: "bad", message: r.message ?? "" }))
        .catch(() => setSlugCheck({ state: "idle", message: "" }));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [customSlug]);

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
    if (customSlug !== null && slugCheck.state === "bad") {
      setError(slugCheck.message || t("signup.webAddress.unavailable"));
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
        ...(customSlug !== null && customSlug.replace(/-+$/, "") && { slug: customSlug.replace(/-+$/, "") }),
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
      if (e instanceof ApiError && e.code === WEB_ADDRESS_UNAVAILABLE_CODE) {
        setSlugCheck({ state: "bad", message: e.message });
      }
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
            {/* D4: the address comes from the name; "Cambiar" lets her write her own. */}
            {customSlug === null && webPreview && (
              <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-gray-500" aria-live="polite">
                <Globe className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                <span>
                  {t("signup.webPreview")} <strong className="font-medium text-gray-700">{webPreview}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => setCustomSlug(suggestedWebAddress(salonName))}
                  className="font-medium text-violet-700 underline hover:text-violet-900"
                >
                  {t("signup.webAddress.change")}
                </button>
              </p>
            )}
            {customSlug !== null && (
              <div className="mt-2">
                <label htmlFor="signup-web-address" className="block text-xs font-medium text-gray-700">
                  {t("signup.webAddress.label")}
                </label>
                <div className="mt-1 flex items-center rounded-lg border border-gray-300 bg-white text-sm focus-within:border-violet-500 focus-within:ring-1 focus-within:ring-violet-500">
                  <input
                    id="signup-web-address"
                    value={customSlug}
                    onChange={(e) => setCustomSlug(typedWebAddress(e.target.value))}
                    maxLength={63}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-l-lg px-3 py-2 outline-none"
                    aria-describedby="signup-web-address-help"
                  />
                  <span className="whitespace-nowrap pr-3 text-gray-500">.{SALON_WEB_BASE}</span>
                </div>
                <p id="signup-web-address-help" className="mt-1 text-xs" aria-live="polite">
                  {slugCheck.state === "checking" && <span className="text-gray-500">{t("signup.webAddress.checking")}</span>}
                  {slugCheck.state === "ok" && <span className="text-green-700">{t("signup.webAddress.available")}</span>}
                  {slugCheck.state === "bad" && <span className="text-red-700">{slugCheck.message}</span>}
                  {slugCheck.state === "idle" && <span className="text-gray-500">{t("signup.webAddress.help")}</span>}
                </p>
                <button
                  type="button"
                  onClick={() => setCustomSlug(null)}
                  className="mt-1 text-xs font-medium text-violet-700 underline hover:text-violet-900"
                >
                  {t("signup.webAddress.useName")}
                </button>
              </div>
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
