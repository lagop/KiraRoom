"use client";

import { useEffect, useState } from "react";
import { LogOut, ShieldAlert } from "lucide-react";
import apiClient from "@/lib/api";
import { authStorage } from "@/lib/auth-storage";
import { ChangePasswordForm } from "@/src/components/auth/change-password-form";
import { TwoFactorSettings } from "@/src/components/auth/two-factor-settings";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";

/**
 * "Cerrar todas las sesiones" (audit 8, C12): every session of the platform
 * owner ends, on every device, and with them every support session opened
 * from them (C13). This browser signs in again.
 */
function SignOutEverywhere() {
  const t = useTranslations();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await apiClient.logoutEverywhere();
      try {
        authStorage().removeItem("user");
      } catch {
        // Storage unavailable: the token is gone anyway.
      }
      document.cookie = "saas_user=; path=/; max-age=0";
      window.location.href = "/saas/login";
    } catch (err) {
      setBusy(false);
      setConfirming(false);
      toast({
        title: t("saas.security.sign_out_all_failed"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <section className="bg-white rounded-xl border border-gray-200 p-6 max-w-2xl space-y-4">
      <div className="flex items-start gap-3">
        <LogOut className="w-6 h-6 text-gray-400 shrink-0" aria-hidden />
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t("saas.security.sign_out_all_title")}</h2>
          <p className="text-sm text-gray-600">{t("saas.security.sign_out_all_body")}</p>
        </div>
      </div>
      <button
        type="button"
        className="px-4 py-2 border border-red-300 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50"
        onClick={() => setConfirming(true)}
        disabled={busy}
      >
        {t("saas.security.sign_out_all_button")}
      </button>
      <ConfirmDialog
        open={confirming}
        title={t("saas.security.sign_out_all_confirm_title")}
        description={t("saas.security.sign_out_all_confirm_body")}
        confirmLabel={t("saas.security.sign_out_all_button")}
        cancelLabel={t("common.cancel")}
        destructive
        loading={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={run}
      />
    </section>
  );
}

/** The platform owner's own security: password, sessions, two-step verification. */
export default function SecurityPage() {
  const t = useTranslations();
  // Audit 8 D15: sent here because the console requires 2FA (lib/api.ts).
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  useEffect(() => {
    setTwoFactorRequired(new URLSearchParams(window.location.search).get("2fa") === "required");
  }, []);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t("saas.security.title")}</h1>
        <p className="text-gray-500 mt-1">{t("saas.security.subtitle")}</p>
      </div>
      {twoFactorRequired && (
        <div role="alert" className="max-w-2xl flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" aria-hidden />
          <div>
            <p className="font-semibold text-amber-900">{t("saas.security.two_factor_required_title")}</p>
            <p className="text-sm text-amber-800">{t("saas.security.two_factor_required_body")}</p>
          </div>
        </div>
      )}
      <ChangePasswordForm />
      <SignOutEverywhere />
      <TwoFactorSettings />
    </div>
  );
}
