"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, Building2, Loader2, Check } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import apiClient from "@/lib/api";



export default function SignupPage() {
  const router = useRouter();
  const t = useTranslations();
  const [salonName, setSalonName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acceptTerms) {
      setError(t("signup.termsRequired"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.register({
        email,
        password,
        salonName,
        phone,
        ownerName,
        language,
        acceptTerms: true,
      });
      if (res?.accessToken) {
        localStorage.setItem("kira_auth_token", res.accessToken);
        if (res.refreshToken) {
          localStorage.setItem("kira_refresh_token", res.refreshToken);
        }
      }
      router.push("/dashboard");
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        (t("signup.errorGeneric"));
      setError(typeof msg === "string" ? msg : JSON.stringify(msg));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="text-lg font-semibold text-gray-900">
          KiraStudio
        </Link>
        <span className="rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-700">
          {t("signup.badge")}
        </span>
      </header>

      <main className="mx-auto max-w-md px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900">{t("signup.title")}</h1>
        <p className="mt-1 text-sm text-gray-600">{t("signup.subtitle")}</p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-3">
          <Field
            label={t("signup.fields.salon")}
            value={salonName}
            onChange={setSalonName}
            required
            autoComplete="organization"
          />
          <Field
            label={t("signup.fields.owner")}
            value={ownerName}
            onChange={setOwnerName}
            required
            autoComplete="name"
          />
          <Field
            label={t("signup.fields.email")}
            value={email}
            onChange={setEmail}
            required
            type="email"
            autoComplete="email"
          />
          <Field
            label={t("signup.fields.phone")}
            value={phone}
            onChange={setPhone}
            required
            type="tel"
            autoComplete="tel"
          />
          <Field
            label={t("signup.fields.password")}
            value={password}
            onChange={setPassword}
            required
            type="password"
            autoComplete="new-password"
          />

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
            <span>{t("signup.terms")}</span>
          </label>

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              <span>{error}</span>
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-700">{label}</span>
      <input
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
      />
    </label>
  );
}