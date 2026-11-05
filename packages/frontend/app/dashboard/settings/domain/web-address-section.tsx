"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import apiClient, { type WebAddressInfo } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useTranslations } from "@/lib/use-translation";
import { SALON_WEB_BASE, typedWebAddress } from "@/lib/signup-form";
import { getCurrentUser } from "@/lib/utils";

/** "4 de noviembre de 2027". */
function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * D4: Ajustes > Web, owner only. The web address can be changed once; the
 * old one sends visitors to the new one (301) for 12 months, then it is free
 * for another salon. Confirmed in the panel's dialog, since it cannot be
 * undone from here.
 */
export function WebAddressSection({ onChanged }: { onChanged: () => void }) {
  const t = useTranslations();
  const { toast } = useToast();
  const [isOwner, setIsOwner] = useState(false);
  const [info, setInfo] = useState<WebAddressInfo | null>(null);
  const [value, setValue] = useState("");
  const [check, setCheck] = useState<{ state: "idle" | "checking" | "ok" | "bad"; message: string }>({
    state: "idle",
    message: "",
  });
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const owner = getCurrentUser()?.role === "owner";
    setIsOwner(owner);
    if (!owner) return;
    apiClient
      .getWebAddress()
      .then((i) => {
        setInfo(i);
        setValue(i.slug);
      })
      .catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    if (!info?.canChange) return;
    const slug = value.replace(/-+$/, "");
    if (!slug || slug === info.slug) {
      setCheck({ state: "idle", message: "" });
      return;
    }
    setCheck({ state: "checking", message: "" });
    const timer = window.setTimeout(() => {
      apiClient
        .checkWebAddress(slug)
        .then((r) => setCheck(r.available ? { state: "ok", message: "" } : { state: "bad", message: r.message ?? "" }))
        .catch(() => setCheck({ state: "idle", message: "" }));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [value, info]);

  if (!isOwner || !info) return null;

  const target = value.replace(/-+$/, "");

  const save = async () => {
    setSaving(true);
    try {
      const r = await apiClient.changeWebAddress(target);
      setInfo({
        slug: r.slug,
        canChange: false,
        changedAt: new Date().toISOString(),
        redirects: [{ oldSlug: r.previous, expiresAt: r.redirectsUntil }],
      });
      setValue(r.slug);
      toast({ title: t("webAddress.changedToast"), description: t("webAddress.redirectNote", { old: r.previous, date: longDate(r.redirectsUntil) }) });
      onChanged();
    } catch (e) {
      toast({ title: t("webAddress.failed"), description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-3">
      <div>
        <h2 className="font-semibold mb-1">{t("webAddress.title")}</h2>
        <p className="text-sm text-gray-500">
          {info.canChange ? t("webAddress.introCanChange") : t("webAddress.introChanged")}
        </p>
      </div>

      {info.redirects.map((r) => (
        <p key={r.oldSlug} className="text-sm text-gray-600">
          {t("webAddress.redirectNote", { old: r.oldSlug, date: longDate(r.expiresAt) })}
        </p>
      ))}

      {info.canChange && (
        <>
          <div className="flex items-center rounded-lg border border-gray-300 bg-white text-sm focus-within:border-violet-500 focus-within:ring-1 focus-within:ring-violet-500">
            <input
              aria-label={t("webAddress.title")}
              value={value}
              onChange={(e) => setValue(typedWebAddress(e.target.value))}
              maxLength={63}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-l-lg px-3 py-2 font-mono outline-none"
            />
            <span className="whitespace-nowrap pr-3 font-mono text-gray-500">.{SALON_WEB_BASE}</span>
          </div>
          <p className="text-xs" aria-live="polite">
            {check.state === "checking" && <span className="text-gray-500">{t("webAddress.checking")}</span>}
            {check.state === "ok" && <span className="text-green-700">{t("webAddress.available")}</span>}
            {check.state === "bad" && <span className="text-red-700">{check.message}</span>}
          </p>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={check.state !== "ok" || saving}
            className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("webAddress.save")}
          </button>
        </>
      )}

      <ConfirmDialog
        open={confirming}
        title={t("webAddress.confirmTitle")}
        description={t("webAddress.confirmBody", { old: info.slug, next: target })}
        confirmLabel={t("webAddress.confirm")}
        cancelLabel={t("webAddress.cancel")}
        loading={saving}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void save()}
      />
    </section>
  );
}
