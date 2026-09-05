"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getToken } from "@/lib/api";
import { Check, Globe, Sparkles, Zap, Calendar, MessageSquare, Users, BarChart3, Loader2 } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import type { SubscriptionPlan } from "@/lib/api";

const FEATURES = [
  { icon: Calendar, key: "booking" },
  { icon: MessageSquare, key: "whatsapp" },
  { icon: Sparkles, key: "ai" },
  { icon: Users, key: "loyalty" },
  { icon: BarChart3, key: "analytics" },
  { icon: Zap, key: "multi" },
];

const STEPS = [1, 2, 3];

export default function LandingPage() {
  const router = useRouter();
  const t = useTranslations();
  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);

  // Redirect already-authenticated users to the dashboard so they don't
  // see the marketing landing after logging in.
  useEffect(() => {
    if (typeof window !== "undefined" && getToken()) {
      router.replace("/dashboard");
    }
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    fetch((process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1") + "/payments/subscription/plans")
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!cancelled) setPlans(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setPlans([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-white text-gray-900">
      <header className="border-b border-gray-100">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-semibold">
            KiraRoom
          </Link>
          <nav className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              {t("landing.hero.ctaLogin")}
            </Link>
            <Link
              href="/signup"
              className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
            >
              {t("landing.hero.ctaPrimary")}
            </Link>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24 text-center">
        <span className="inline-block rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs text-gray-600">
          {t("landing.badge")}
        </span>
        <h1 className="mt-6 text-3xl font-bold tracking-tight sm:text-5xl">
          {t("landing.hero.title")}
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-base text-gray-600 sm:text-lg">
          {t("landing.hero.subtitle")}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/signup"
            className="rounded-md bg-violet-600 px-6 py-3 text-sm font-medium text-white shadow-sm hover:bg-violet-700"
          >
            {t("landing.hero.ctaPrimary")}
          </Link>
          <Link
            href="/example-booking"
            className="rounded-md border border-gray-200 px-6 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {t("landing.hero.ctaSecondary")}
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-12">
        <h2 className="sr-only">{t("landing.features.title")}</h2>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.key}
                className="rounded-lg border border-gray-100 bg-white p-5 shadow-sm"
              >
                <Icon className="h-5 w-5 text-violet-600" />
                <h3 className="mt-3 text-base font-semibold">
                  {t(`landing.features.${f.key}.title`)}
                </h3>
                <p className="mt-1 text-sm text-gray-600">
                  {t(`landing.features.${f.key}.desc`)}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="bg-gray-50">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center text-2xl font-bold">
            {t("landing.how.title")}
          </h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {STEPS.map((n) => (
              <div
                key={n}
                className="rounded-lg bg-white p-6 text-center shadow-sm"
              >
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-violet-100 text-violet-700 font-semibold">
                  {n}
                </div>
                <h3 className="text-base font-semibold">
                  {t(`landing.how.step${n}.title`)}
                </h3>
                <p className="mt-1 text-sm text-gray-600">
                  {t(`landing.how.step${n}.desc`)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="text-center">
          <h2 className="text-2xl font-bold">{t("landing.pricing.title")}</h2>
          <p className="mt-2 text-sm text-gray-600">
            {t("landing.pricing.subtitle")}
          </p>
        </div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans === null ? (
            <div className="col-span-full flex items-center justify-center py-8 text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (
            plans.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
              >
                <div className="flex items-baseline justify-between">
                  <h3 className="text-lg font-semibold">
                    {t(`plans.${p.id}`, { default: p.name })}
                  </h3>
                  {p.id === "pro" && (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      {t("landing.pricing.popular")}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-2xl font-bold">
                  &euro;{(p.price / 100).toFixed(0)}
                  <span className="ml-1 text-sm font-normal text-gray-500">
                    {t("landing.pricing.perMonth")}
                  </span>
                </p>
                {p.id === "empresa" && (
                  <p className="text-xs text-gray-500">
                    {t("landing.pricing.minLocations")}
                  </p>
                )}
                <ul className="mt-4 space-y-1.5 text-sm text-gray-600">
                  {(p.features ?? []).slice(0, 5).map((f) => (
                    <li key={f} className="flex items-start gap-1.5">
                      <Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-500" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/signup"
                  className="mt-4 block w-full rounded-md bg-violet-600 px-3 py-2 text-center text-sm font-medium text-white hover:bg-violet-700"
                >
                  {t("landing.hero.ctaPrimary")}
                </Link>
              </div>
            ))
          )}
        </div>
        <div className="mt-8 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold">
                <Globe className="mr-1.5 inline h-4 w-4" />
                {t("landing.addon.title")}
              </h3>
              <p className="mt-1 text-sm text-gray-600">
                {t("landing.addon.desc")}
              </p>
            </div>
            <Link
              href="/signup"
              className="rounded-md border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              {t("landing.pricing.learnMore")}
            </Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-gray-100">
        <div className="mx-auto max-w-6xl px-6 py-8 text-sm text-gray-500">
          <p>
            &copy; {new Date().getFullYear()} KiraRoom. {t("landing.footer")}
          </p>
        </div>
      </footer>
    </div>
  );
}