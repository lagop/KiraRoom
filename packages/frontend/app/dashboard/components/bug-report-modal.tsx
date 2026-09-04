"use client";

import { useEffect, useState } from "react";
import { X, Bug, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import apiClient from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";

interface BugReportModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Bug-report modal. Sprint 1 Workstream 1.5 deliverable, with the
 * completion gap (Sprint 2 review, A2.1) closed in 2026-07-17:
 *
 *   - Pre-fills `email` from the logged-in user when available, so
 *     the backend `sendBugReportAck` email can be delivered.
 *   - Captures `currentUrl` (window.location.href) and `appVersion`
 *     (NEXT_PUBLIC_APP_VERSION or "dev") automatically.
 *   - Shows the backend-returned tracking id on success so the
 *     reporter can reference it later.
 *
 * Anonymous-friendly: if no user is logged in, the email field is
 * still shown and optional. The backend ack is skipped when email
 * is empty (BugReportService.submit), but the report still reaches
 * the founder.
 */
export function BugReportModal({ open, onClose }: BugReportModalProps) {
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<null | {
    id: string;
    shortId: string;
  }>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the modal closes, and pre-fill email from the
  // current session the next time it opens.
  useEffect(() => {
    if (!open) {
      setSubject("");
      setDescription("");
      setEmail("");
      setSubmitting(false);
      setSubmitted(null);
      setError(null);
      return;
    }
    try {
      const u = getCurrentUser();
      if (u?.email) setEmail(u.email);
    } catch {
      /* getCurrentUser failed (e.g. SSR-ish state) — leave email blank */
    }
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!subject.trim() || !description.trim()) {
      setError("El asunto y la descripción son obligatorios.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiClient.reportBug({
        subject: subject.trim(),
        description: description.trim(),
        email: email.trim() || undefined,
        currentUrl: typeof window !== "undefined" ? window.location.href : undefined,
        appVersion:
          process.env.NEXT_PUBLIC_APP_VERSION || "dev",
      });
      setSubmitted({ id: res.id, shortId: res.id.slice(0, 8) });
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ||
        err?.message ||
        "No se pudo enviar el reporte. Inténtalo de nuevo en unos minutos.";
      setError(typeof msg === "string" ? msg : JSON.stringify(msg));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bug-report-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
        padding: 16,
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          width: "100%",
          maxWidth: 560,
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: "0 24px 48px rgba(15, 23, 42, 0.18)",
        }}
      >
        {submitted ? (
          <div style={{ padding: 32, textAlign: "center" }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 56,
                height: 56,
                borderRadius: 999,
                background: "#dcfce7",
                marginBottom: 16,
              }}
            >
              <CheckCircle2 className="w-7 h-7 text-emerald-600" />
            </div>
            <h2
              id="bug-report-title"
              style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}
            >
              ¡Gracias por el reporte!
            </h2>
            <p style={{ color: "#64748b", marginBottom: 16 }}>
              {email.trim() ? (
                <>
                  Te hemos enviado un correo de confirmación a{" "}
                  <strong>{email.trim()}</strong>.
                </>
              ) : (
                <>El reporte se ha enviado al equipo técnico.</>
              )}
            </p>
            <p
              style={{
                fontSize: 13,
                color: "#94a3b8",
                background: "#f1f5f9",
                padding: 12,
                borderRadius: 8,
                marginBottom: 24,
              }}
            >
              Identificador de seguimiento: <strong>{submitted.shortId}</strong>
              <br />
              (referencia este código si vuelves a escribirnos)
            </p>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "10px 20px",
                background: "#4f46e5",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Cerrar
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "20px 24px",
                borderBottom: "1px solid #e2e8f0",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Bug className="w-5 h-5 text-rose-600" />
                <h2
                  id="bug-report-title"
                  style={{ fontSize: 18, fontWeight: 700, margin: 0 }}
                >
                  Reportar un bug
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Cerrar"
                style={{
                  background: "transparent",
                  border: "none",
                  fontSize: 22,
                  cursor: "pointer",
                  color: "#64748b",
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>

            <div style={{ padding: 24 }}>
              <p
                style={{
                  fontSize: 13,
                  color: "#64748b",
                  marginBottom: 16,
                }}
              >
                Cuéntanos qué ha pasado. Capturaremos la URL y la versión
                de la app automáticamente. Si nos dejas tu email te
                enviaremos un acuse con un identificador de seguimiento.
              </p>

              <label
                style={{
                  display: "block",
                  marginBottom: 12,
                  fontSize: 13,
                  fontWeight: 500,
                  color: "#0f172a",
                }}
              >
                Asunto
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  maxLength={200}
                  required
                  placeholder="Ej. El botón Guardar no hace nada en /dashboard/calendar"
                  style={{
                    display: "block",
                    width: "100%",
                    marginTop: 4,
                    padding: "8px 12px",
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    fontSize: 14,
                  }}
                />
              </label>

              <label
                style={{
                  display: "block",
                  marginBottom: 12,
                  fontSize: 13,
                  fontWeight: 500,
                  color: "#0f172a",
                }}
              >
                Descripción
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                  rows={5}
                  maxLength={4000}
                  placeholder="¿Qué estabas haciendo? ¿Qué esperabas? ¿Qué ha pasado en su lugar?"
                  style={{
                    display: "block",
                    width: "100%",
                    marginTop: 4,
                    padding: "8px 12px",
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    fontSize: 14,
                    resize: "vertical",
                  }}
                />
              </label>

              <label
                style={{
                  display: "block",
                  marginBottom: 16,
                  fontSize: 13,
                  fontWeight: 500,
                  color: "#0f172a",
                }}
              >
                Tu email (opcional)
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Si quieres recibir un acuse con el identificador"
                  style={{
                    display: "block",
                    width: "100%",
                    marginTop: 4,
                    padding: "8px 12px",
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    fontSize: 14,
                  }}
                />
              </label>

              {error && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 8,
                    padding: 12,
                    background: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: 6,
                    color: "#991b1b",
                    fontSize: 13,
                    marginBottom: 12,
                  }}
                >
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                }}
              >
                <button
                  type="button"
                  onClick={onClose}
                  disabled={submitting}
                  style={{
                    padding: "8px 16px",
                    background: "#fff",
                    color: "#0f172a",
                    border: "1px solid #cbd5e1",
                    borderRadius: 6,
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 16px",
                    background: "#4f46e5",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    fontWeight: 600,
                    cursor: "pointer",
                    opacity: submitting ? 0.6 : 1,
                  }}
                >
                  {submitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Bug className="w-4 h-4" />
                  )}
                  Enviar reporte
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default BugReportModal;