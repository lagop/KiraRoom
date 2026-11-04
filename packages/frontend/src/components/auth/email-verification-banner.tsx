"use client";

import { useEffect, useState } from "react";
import { Mail, X } from "lucide-react";
import apiClient, { decodeJwtToken, getToken } from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";
import { useTranslations } from "@/lib/use-translation";
import { EMAIL_NOTICE_DISMISS_KEY, showEmailVerificationNotice } from "@/lib/signup-form";

function readDismissedAt(): string | null {
  try {
    return window.localStorage.getItem(EMAIL_NOTICE_DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * S1(a): "Confirma tu email" across the panel for an owner whose address is
 * not confirmed, with a button that emails a new link (3 an hour). Closing
 * it hides it for 3 days. Nothing is blocked for an unconfirmed email yet.
 */
export function EmailVerificationBanner() {
  const t = useTranslations();
  const [role, setRole] = useState<string | null>(null);
  const [impersonated, setImpersonated] = useState(false);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const r = getCurrentUser()?.role ?? null;
    const token = getToken();
    const claims = token ? decodeJwtToken(token) : null;
    setRole(r);
    setImpersonated(Boolean(claims?.impersonatedBy));
    setDismissedAt(readDismissedAt());
    if (r !== "owner" || claims?.impersonatedBy) return;
    apiClient
      .getEmailVerification()
      .then((s) => {
        setVerified(s.verified);
        setEmail(s.email);
      })
      .catch(() => setVerified(null));
  }, []);

  if (!showEmailVerificationNotice({ role, verified, impersonated, dismissedAt, now: new Date() })) return null;

  const dismiss = () => {
    const at = new Date().toISOString();
    setDismissedAt(at);
    try {
      window.localStorage.setItem(EMAIL_NOTICE_DISMISS_KEY, at);
    } catch {
      // Storage blocked: hidden for this visit only.
    }
  };

  const resend = async () => {
    setState("sending");
    setMessage("");
    try {
      const r = await apiClient.resendVerificationEmail();
      if (r.alreadyVerified) {
        setVerified(true);
        return;
      }
      setState(r.sent ? "sent" : "error");
      if (!r.sent) setMessage(t("emailVerifyNotice.failed"));
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error && e.message ? e.message : t("emailVerifyNotice.failed"));
    }
  };

  return (
    <div
      role="status"
      className="flex flex-col gap-2 border-b border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 sm:flex-row sm:items-center sm:justify-between sm:px-6"
    >
      <div className="flex items-start gap-3">
        <Mail className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <p>
          <strong className="font-semibold">{t("emailVerifyNotice.title")}</strong>{" "}
          {state === "sent"
            ? t("emailVerifyNotice.sent", { email: email ?? "" })
            : t("emailVerifyNotice.body", { email: email ?? "" })}
          {state === "error" && message && <span className="block text-red-700">{message}</span>}
        </p>
      </div>
      <div className="flex items-center gap-2 self-start sm:self-auto">
        {state !== "sent" && (
          <button
            type="button"
            onClick={() => void resend()}
            disabled={state === "sending"}
            className="whitespace-nowrap rounded-md bg-gray-900 px-3 py-1.5 font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {state === "sending" ? t("emailVerifyNotice.sending") : t("emailVerifyNotice.resend")}
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="rounded p-1 opacity-60 hover:opacity-100"
          aria-label={t("emailVerifyNotice.dismiss")}
          title={t("emailVerifyNotice.dismiss")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
