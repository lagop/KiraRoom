"use client";

import { useCallback, useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, CheckCircle2, Loader2, Mail } from "lucide-react";
import apiClient, { getToken } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

type Status = "checking" | "verified" | "invalid" | "error";

/**
 * Confirms an email address from the welcome email's link
 * (/verify-email?token=...). Usually opened signed out. The token is single
 * use, so it is sent once: React's dev-mode double effect would otherwise
 * spend it on the first call and show "invalid" for the second.
 */
function VerifyEmailPageContent() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const token = searchParams?.get("token") || "";
  const [status, setStatus] = useState<Status>(token ? "checking" : "invalid");
  // Read after mount: localStorage does not exist on the server render.
  const [signedIn, setSignedIn] = useState(false);
  const sent = useRef(false);
  // "Reenviar el email" on an expired link: needs the session (the endpoint
  // sends to the signed-in account's own address).
  const [resend, setResend] = useState<"idle" | "sending" | "sent" | "already" | "error">("idle");
  const [resendError, setResendError] = useState("");

  const resendEmail = async () => {
    setResend("sending");
    setResendError("");
    try {
      const r = await apiClient.resendVerificationEmail();
      setResend(r.alreadyVerified ? "already" : r.sent ? "sent" : "error");
      if (!r.sent && !r.alreadyVerified) setResendError(t("email_verify.resend_failed"));
    } catch (e) {
      setResend("error");
      setResendError(e instanceof Error && e.message ? e.message : t("email_verify.resend_failed"));
    }
  };

  const verify = useCallback(async () => {
    setStatus("checking");
    try {
      const { verified } = await apiClient.verifyEmail(token);
      setStatus(verified ? "verified" : "invalid");
    } catch {
      // No answer about the token (network, rate limit): it may still be good.
      setStatus("error");
    }
  }, [token]);

  useEffect(() => {
    setSignedIn(!!getToken());
    if (!token || sent.current) return;
    sent.current = true;
    void verify();
  }, [token, verify]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="w-full max-w-md bg-white rounded-xl shadow-sm border border-gray-100 p-8">
        {status === "checking" && (
          <>
            <h1 className="text-2xl font-bold text-gray-900 mb-6">{t("email_verify.title")}</h1>
            <p className="text-sm text-gray-600 flex items-center gap-2" role="status">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t("email_verify.checking")}
            </p>
          </>
        )}

        {status === "verified" && (
          <>
            <h1 className="text-2xl font-bold text-gray-900 mb-6">{t("email_verify.done_title")}</h1>
            <div className="bg-green-50 text-green-800 p-4 rounded-lg flex gap-2" role="status">
              <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <p className="text-sm">{t("email_verify.done")}</p>
            </div>
            <a
              href={signedIn ? "/dashboard" : "/login"}
              className="mt-6 block w-full text-center bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700"
            >
              {signedIn ? t("email_verify.go_dashboard") : t("email_verify.go_login")}
            </a>
          </>
        )}

        {status === "invalid" && (
          <>
            <h1 className="text-2xl font-bold text-gray-900 mb-6">{t("email_verify.invalid_title")}</h1>
            <div className="bg-red-50 text-red-600 p-3 rounded-lg flex items-center text-sm" role="alert">
              <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0" />
              <span>{t("email_verify.invalid")}</span>
            </div>
            {signedIn ? (
              <div className="mt-6">
                {resend === "sent" ? (
                  <p className="bg-green-50 text-green-800 p-3 rounded-lg text-sm" role="status">
                    {t("email_verify.resend_sent")}
                  </p>
                ) : resend === "already" ? (
                  <p className="bg-green-50 text-green-800 p-3 rounded-lg text-sm" role="status">
                    {t("email_verify.already_verified")}
                  </p>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void resendEmail()}
                      disabled={resend === "sending"}
                      className="w-full inline-flex items-center justify-center gap-2 bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700 disabled:opacity-50"
                    >
                      {resend === "sending" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                      {t("email_verify.resend")}
                    </button>
                    {resendError && (
                      <p className="mt-2 text-sm text-red-600" role="alert">
                        {resendError}
                      </p>
                    )}
                  </>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-600 mt-4">{t("email_verify.resend_signed_out")}</p>
            )}
          </>
        )}

        {status === "error" && (
          <>
            <h1 className="text-2xl font-bold text-gray-900 mb-6">{t("email_verify.title")}</h1>
            <div className="bg-red-50 text-red-600 p-3 rounded-lg flex items-center text-sm" role="alert">
              <AlertCircle className="w-5 h-5 mr-2 flex-shrink-0" />
              <span>{t("email_verify.error")}</span>
            </div>
            <button
              type="button"
              onClick={() => void verify()}
              className="mt-6 w-full bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700"
            >
              {t("email_verify.retry")}
            </button>
          </>
        )}

        {(status === "invalid" || status === "error") && (
          <p className="text-sm mt-6">
            <a href="/login" className="text-purple-600 hover:underline">
              {t("email_verify.back_to_login")}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}

// useSearchParams() needs a Suspense boundary for the page to prerender
// (required since Next.js 14.1; 14.0 let it through).
export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailPageContent />
    </Suspense>
  );
}
