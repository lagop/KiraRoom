"use client";

import { useEffect, useState } from "react";
import apiClient, { decodeJwtToken, getToken } from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";
import { signOut } from "@/lib/sign-out";
import { useTranslations } from "@/lib/use-translation";
import { Button } from "@/components/ui/Button";

/**
 * D3: an owner whose salon has not accepted the current terms (salons from
 * before acceptances were recorded, and every salon again when the terms'
 * version changes) is asked once, on entering the panel. The panel waits
 * behind the dialog until the box is ticked and accepted; the only other way
 * out is signing out. Nothing shows for the team or for support.
 */
export function TermsAcceptanceModal() {
  const t = useTranslations();
  const [required, setRequired] = useState(false);
  const [lastUpdated, setLastUpdated] = useState("");
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const role = getCurrentUser()?.role ?? null;
    const token = getToken();
    const claims = token ? decodeJwtToken(token) : null;
    if (role !== "owner" || claims?.impersonatedBy) return;
    apiClient
      .getTermsStatus()
      .then((s) => {
        setRequired(s.required);
        setLastUpdated(s.lastUpdated);
      })
      .catch(() => setRequired(false));
  }, []);

  if (!required) return null;

  const accept = async () => {
    if (!checked) return;
    setSaving(true);
    setError("");
    try {
      await apiClient.acceptTerms();
      setRequired(false);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t("termsUpdate.failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="terms-update-title"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-xl">
        <h2 id="terms-update-title" className="mb-2 text-base font-semibold text-gray-900">
          {t("termsUpdate.title")}
        </h2>
        <p className="mb-4 text-sm text-gray-600">{t("termsUpdate.body", { date: lastUpdated })}</p>
        <label className="mb-4 flex items-start gap-2 text-sm text-gray-800">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>
            {t("termsUpdate.checkbox")}{" "}
            (
            <a href="/legal/terms" target="_blank" rel="noopener noreferrer" className="text-violet-700 underline">
              {t("termsUpdate.terms")}
            </a>
            {" · "}
            <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-violet-700 underline">
              {t("termsUpdate.privacy")}
            </a>
            )
          </span>
        </label>
        {error && <p className="mb-3 text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => void signOut()} disabled={saving}>
            {t("termsUpdate.signOut")}
          </Button>
          <Button size="sm" onClick={() => void accept()} disabled={!checked || saving}>
            {saving ? t("termsUpdate.saving") : t("termsUpdate.accept")}
          </Button>
        </div>
      </div>
    </div>
  );
}
