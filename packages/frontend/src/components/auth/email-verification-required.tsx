"use client";

import { useEffect, useState } from "react";
import { MailWarning } from "lucide-react";
import apiClient, { decodeJwtToken, getToken } from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";
import { useTranslations } from "@/lib/use-translation";

/**
 * D1: on the pages whose sends wait for the owner's confirmed email (email
 * and WhatsApp campaigns), says so before anyone writes a campaign. The
 * owner gets the button that emails a new link; anyone else is told the
 * owner has to confirm. Nothing shows once the salon is confirmed, or if
 * the status cannot be read (the server still refuses the send).
 */
export function EmailVerificationRequired() {
  const t = useTranslations();
  const [salonVerified, setSalonVerified] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [canResend, setCanResend] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const role = getCurrentUser()?.role ?? null;
    const token = getToken();
    const claims = token ? decodeJwtToken(token) : null;
    setIsOwner(role === "owner");
    setCanResend(role === "owner" && !claims?.impersonatedBy);
    apiClient
      .getEmailVerification()
      .then((s) => {
        setSalonVerified(s.salonVerified ?? true);
        setEmail(s.email);
      })
      .catch(() => setSalonVerified(null));
  }, []);

  if (salonVerified !== false) return null;

  const resend = async () => {
    setState("sending");
    setMessage("");
    try {
      const r = await apiClient.resendVerificationEmail();
      if (r.alreadyVerified) {
        setSalonVerified(true);
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
    <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <div className="flex items-start gap-3">
        <MailWarning className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
        <div className="space-y-2">
          <p className="font-semibold">{t("emailVerifyRequired.title")}</p>
          <p>
            {isOwner
              ? state === "sent"
                ? t("emailVerifyNotice.sent", { email: email ?? "" })
                : t("emailVerifyRequired.ownerBody", { email: email ?? "" })
              : t("emailVerifyRequired.teamBody")}
          </p>
          {state === "error" && message && <p className="text-red-700">{message}</p>}
          {canResend && state !== "sent" && (
            <button
              type="button"
              onClick={() => void resend()}
              disabled={state === "sending"}
              className="rounded-md bg-gray-900 px-3 py-1.5 font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {state === "sending" ? t("emailVerifyNotice.sending") : t("emailVerifyNotice.resend")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
