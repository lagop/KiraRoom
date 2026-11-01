"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Star, Filter, ExternalLink, AlertCircle, CheckCircle2, MessageCircle } from "lucide-react";
import apiClient, { Review, ReviewAnalytics, ReviewSettings } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  LEGACY_REJECTION_REASON,
  REJECTION_REASONS,
  moderationLine,
  publicVisibilityNote,
  requestsHeadline,
  whatsappChannelView,
} from "@/lib/reviews";

const STATUS_LABEL: Record<Review["status"], string> = {
  pending: "Sin responder",
  moderation: "Por moderar",
  published: "Aprobada",
  rejected: "Rechazada",
};

const SOURCE_LABEL: Record<string, string> = {
  email_link: "email",
  sms_link: "SMS",
  whatsapp_link: "WhatsApp",
};

export default function ReviewsDashboardPage() {
  const { toast } = useToast();
  const [reviews, setReviews] = useState<Review[]>([]);
  const [analytics, setAnalytics] = useState<ReviewAnalytics | null>(null);
  const [settings, setSettings] = useState<ReviewSettings | null>(null);
  const [rating, setRating] = useState<number | "all">("all");
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);
  // The review about to be rejected or hidden, and the reason picked for it.
  const [rejecting, setRejecting] = useState<Review | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, stats] = await Promise.all([
        apiClient.listReviews({
          rating: rating === "all" ? undefined : Number(rating),
          status: status || undefined,
        }),
        apiClient.getReviewAnalytics(),
      ]);
      setReviews(list);
      setAnalytics(stats);
    } catch (err: any) {
      toast({ title: err?.message ?? "No se pudieron cargar las reseñas", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [rating, status, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    apiClient
      .getReviewSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  const reasons = settings?.policy.rejectionReasons?.length ? settings.policy.rejectionReasons : REJECTION_REASONS;
  const graceDays = settings?.policy.moderationGraceDays ?? 7;

  async function approve(id: string) {
    try {
      await apiClient.moderateReview(id, "approve");
      toast({ title: "Aprobada" });
      await load();
    } catch (err: any) {
      toast({ title: err?.message ?? "Error", variant: "destructive" });
    }
  }

  function askReject(r: Review) {
    setReason(r.moderationReason && r.moderationReason !== LEGACY_REJECTION_REASON ? r.moderationReason : "");
    setRejecting(r);
  }

  async function confirmReject() {
    if (!rejecting) return;
    if (!reason) {
      toast({ title: "Elige el motivo", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await apiClient.moderateReview(rejecting.id, "reject", reason);
      toast({ title: rejecting.status === "published" ? "Ocultada" : "Rechazada" });
      setRejecting(null);
      await load();
    } catch (err: any) {
      toast({ title: err?.message ?? "Error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 truncate">Reseñas</h1>
        <p className="text-gray-500 mt-1">{requestsHeadline(settings)}</p>
      </div>

      {settings && (
        <SettingsCard settings={settings} onSaved={setSettings} />
      )}

      <div className="bg-white border border-gray-200 rounded-xl p-4 text-sm text-gray-600 space-y-1">
        <div className="font-medium text-gray-900">Cómo se publican</div>
        <p>
          Tu web dice que se publican todas las opiniones de clientas con una cita completada, positivas y negativas,
          salvo las que incumplen estas normas. Por eso solo puedes rechazar u ocultar una por uno de estos motivos:{" "}
          {reasons.map((r) => r.label.toLowerCase()).join(", ")}. Queda registrado quién lo hizo y cuándo.
        </p>
        <p>
          Si no revisas una opinión en {graceDays} días, se publica sola. La media cuenta todas las valoraciones salvo
          las rechazadas; las de clientas que no dieron permiso para mostrarlas cuentan sin nombre ni comentario.
        </p>
      </div>

      {analytics && (analytics.legacyRejections ?? 0) > 0 && (
        <div className="flex items-start gap-2 text-sm bg-amber-50 text-amber-800 p-3 rounded-xl">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Tienes {analytics.legacyRejections}{" "}
            {analytics.legacyRejections === 1 ? "reseña rechazada" : "reseñas rechazadas"} antes de que hubiera
            motivos. Revísalas: apruébalas o elige el motivo por el que no se publican.{" "}
            <button type="button" className="underline" onClick={() => setStatus("rejected")}>
              Ver rechazadas
            </button>
          </span>
        </div>
      )}

      {analytics && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Card
            label="Valoración media"
            value={analytics.total ? analytics.averageRating.toFixed(1) : "—"}
            hint={`${analytics.total} valoraci${analytics.total === 1 ? "ón" : "ones"}, sin contar las rechazadas`}
          />
          <Card
            label="Peticiones enviadas"
            value={String(analytics.requestsSent)}
            hint={`${Math.round(analytics.responseRate * 100)}% respondidas`}
          />
          <Card label="Por moderar" value={String(analytics.pendingModeration)} />
          <Card
            label="Abrieron Google"
            value={String(analytics.googleClicks)}
            hint="Pulsaron el botón; Google no nos dice si publicaron"
          />
        </div>
      )}

      {analytics && analytics.total > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 max-w-md">
          <div className="text-xs text-gray-500 uppercase mb-2">Distribución</div>
          <div className="space-y-1">
            {analytics.distribution
              .slice()
              .reverse()
              .map((count, idx) => {
                const stars = 5 - idx;
                const pct = Math.round((count / analytics.total) * 100);
                return (
                  <div key={stars} className="flex items-center gap-2 text-xs">
                    <span className="w-6">{stars}★</span>
                    <div className="flex-1 bg-gray-100 rounded h-2 overflow-hidden">
                      <div className="bg-yellow-400 h-full" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="w-10 text-right">{count}</span>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex flex-col gap-2 mb-4 sm:flex-row sm:items-center sm:gap-3">
          <Filter className="hidden w-4 h-4 text-gray-500 sm:block" />
          <select
            value={rating}
            onChange={(e) =>
              setRating(e.target.value === "all" ? "all" : Number(e.target.value))
            }
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm sm:w-auto"
          >
            <option value="all">Todas las estrellas</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n}★
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm sm:w-auto"
          >
            <option value="">Todas las respondidas</option>
            <option value="moderation">Por moderar</option>
            <option value="published">Aprobadas</option>
            <option value="rejected">Rechazadas</option>
            <option value="pending">Peticiones sin responder</option>
          </select>
        </div>
        {loading ? (
          <div className="text-gray-500 text-sm">Cargando…</div>
        ) : reviews.length === 0 ? (
          <div className="text-gray-500 text-sm">
            {status === "pending"
              ? "No hay peticiones pendientes de respuesta."
              : "Todavía no hay reseñas."}
          </div>
        ) : (
          <div className="divide-y">
            {reviews.map((r) => {
              const legacy = r.status === "rejected" && r.moderationReason === LEGACY_REJECTION_REASON;
              const line = moderationLine(r);
              const visibility = publicVisibilityNote(r);
              return (
                <div key={r.id} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3">
                  {r.status !== "pending" && (
                    <div className="flex shrink-0">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <Star
                          key={n}
                          className={`w-4 h-4 ${
                            n <= r.rating ? "fill-yellow-400 text-yellow-400" : "text-gray-200"
                          }`}
                        />
                      ))}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-gray-900">
                      {r.clientName ?? "Clienta"}
                      {r.serviceName && <span className="text-gray-500"> · {r.serviceName}</span>}
                      {r.professionalName && <span className="text-gray-500"> · {r.professionalName}</span>}
                    </div>
                    <div className="text-xs text-gray-500">
                      {new Date(r.submittedAt ?? r.createdAt).toLocaleString("es-ES")}
                      {SOURCE_LABEL[r.source] && ` · pedida por ${SOURCE_LABEL[r.source]}`}
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                      {legacy && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                          Sin motivo (anterior)
                        </span>
                      )}
                      {r.googleLinkClickedAt && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">
                          Abrió Google
                        </span>
                      )}
                    </div>
                    {r.comment && <div className="text-sm text-gray-700 mt-1">{r.comment}</div>}
                    {line && (
                      <div className={`text-xs mt-1 ${legacy ? "text-amber-800" : "text-gray-500"}`}>{line}</div>
                    )}
                    {visibility && <div className="text-xs text-gray-500 mt-1">{visibility}</div>}
                    {r.status === "moderation" && (
                      <div className="text-xs text-gray-500 mt-1">
                        Si no la revisas, se publicará sola a los {graceDays} días de recibirla.
                      </div>
                    )}
                  </div>
                  {r.status !== "pending" && (
                    <div className="flex gap-2 shrink-0">
                      {r.status !== "published" && (
                        <button
                          onClick={() => approve(r.id)}
                          className="text-xs text-green-700 hover:bg-green-50 px-2 py-1 rounded"
                        >
                          Aprobar
                        </button>
                      )}
                      {(r.status !== "rejected" || legacy) && (
                        <button
                          onClick={() => askReject(r)}
                          className="text-xs text-red-700 hover:bg-red-50 px-2 py-1 rounded"
                        >
                          {legacy ? "Elegir motivo" : r.status === "published" ? "Ocultar" : "Rechazar"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!rejecting}
        title={rejecting?.status === "published" ? "¿Ocultar esta reseña?" : "¿Rechazar esta reseña?"}
        description={
          <div className="space-y-2 text-left">
            <p>
              Solo puedes hacerlo si incumple las normas que tu web publica. No se mostrará ni contará en la media, y
              quedará registrado el motivo, quién lo hizo y cuándo.
            </p>
            <label className="block text-sm font-medium text-gray-700" htmlFor="review-reject-reason">
              Motivo
            </label>
            <select
              id="review-reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            >
              <option value="">— Elige el motivo —</option>
              {reasons.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        }
        confirmLabel={rejecting?.status === "published" ? "Ocultar" : "Rechazar"}
        destructive
        loading={saving}
        onCancel={() => setRejecting(null)}
        onConfirm={confirmReject}
      />
    </div>
  );
}

function SettingsCard({
  settings,
  onSaved,
}: {
  settings: ReviewSettings;
  onSaved: (s: ReviewSettings) => void;
}) {
  const { toast } = useToast();
  const [placeId, setPlaceId] = useState(settings.googlePlaceId ?? "");
  const [url, setUrl] = useState(settings.googleWriteReviewUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [submittingTemplate, setSubmittingTemplate] = useState(false);
  const whatsapp = whatsappChannelView(settings.channels.whatsapp);

  async function submitTemplate() {
    setSubmittingTemplate(true);
    try {
      const next = await apiClient.submitReviewWhatsAppTemplate();
      onSaved(next);
      toast({ title: "Plantilla enviada a Meta", description: "Meta suele revisarla en unas horas." });
    } catch (err: any) {
      toast({ title: "No se pudo enviar la plantilla", description: err?.message, variant: "destructive" });
    } finally {
      setSubmittingTemplate(false);
    }
  }

  async function save(patch: Parameters<typeof apiClient.updateReviewSettings>[0]) {
    setSaving(true);
    try {
      const next = await apiClient.updateReviewSettings(patch);
      onSaved(next);
      toast({ title: "Guardado" });
    } catch (err: any) {
      toast({ title: err?.message ?? "No se pudo guardar", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
      <h2 className="font-semibold text-gray-900">Configuración</h2>

      <div className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-gray-900">Pedir opinión tras la cita</div>
            <p className="text-xs text-gray-500">
              Por WhatsApp a las clientas que pidieron los avisos de sus citas por WhatsApp (cuando Meta apruebe tu
              plantilla) y por email al resto, {settings.policy.delayHours} horas después de marcar la cita como
              completada y entre las 9:00 y las 21:00 de tu salón (solo citas de los últimos{" "}
              {Math.round((settings.policy.windowHours ?? 72) / 24)} días). Como mucho una vez cada{" "}
              {settings.policy.clientCooldownDays} días por clienta, y nunca a quien haya dicho que no o cuyo email haya
              rebotado o se haya dado de baja.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm shrink-0">
            <input
              type="checkbox"
              checked={settings.autoRequestsEnabled}
              disabled={saving || !settings.addOnActive}
              onChange={(e) => save({ autoRequestsEnabled: e.target.checked })}
            />
            {settings.autoRequestsEnabled ? "Activado" : "Desactivado"}
          </label>
        </div>
        {!settings.addOnActive && (
          <div className="flex items-start gap-2 text-xs bg-amber-50 text-amber-800 p-2 rounded">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>
              Las peticiones automáticas forman parte del complemento «Reseñas tras la cita».{" "}
              <Link href="/dashboard/billing?buy=google_reviews_auto" className="underline">
                Ver complementos
              </Link>
            </span>
          </div>
        )}
        {whatsapp && (
          <div className="rounded border border-gray-200 p-3 text-xs space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <MessageCircle className="w-4 h-4 text-green-600" />
              <span className="font-medium text-gray-900">WhatsApp</span>
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  {
                    gray: "bg-gray-100 text-gray-700",
                    amber: "bg-amber-100 text-amber-800",
                    green: "bg-green-100 text-green-800",
                    red: "bg-red-100 text-red-700",
                  }[whatsapp.tone]
                }`}
              >
                {whatsapp.label}
              </span>
            </div>
            <p className="text-gray-600">{whatsapp.detail}</p>
            {whatsapp.canSubmit && (
              <button
                type="button"
                disabled={submittingTemplate}
                onClick={submitTemplate}
                className="bg-green-600 text-white text-xs px-3 py-1.5 rounded hover:bg-green-700 disabled:opacity-50"
              >
                {submittingTemplate ? "Enviando…" : "Enviar plantilla a Meta"}
              </button>
            )}
            {whatsapp.needsConnection && (
              <Link href="/dashboard/settings/whatsapp" className="inline-block text-blue-700 underline">
                Conectar WhatsApp
              </Link>
            )}
          </div>
        )}
        {settings.addOnActive && settings.autoRequestsEnabled && !settings.channels.email && (
          <div className="flex items-start gap-2 text-xs bg-amber-50 text-amber-800 p-2 rounded">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>
              {settings.channels.whatsapp === "APPROVED"
                ? "El envío de emails no está configurado: ahora mismo solo se pide la opinión por WhatsApp, a quien pidió los avisos de sus citas por WhatsApp."
                : "El envío de emails no está configurado, así que ahora mismo no se enviará nada."}
            </span>
          </div>
        )}
      </div>

      <div className="space-y-2 border-t pt-4">
        <div className="text-sm font-medium text-gray-900">Tu ficha de Google</div>
        <p className="text-xs text-gray-500">
          Tras valorar, la clienta ve un botón para dejar también su reseña en Google, sea cual sea su valoración. Pega
          aquí el Place ID de tu negocio (búscalo en el «Place ID Finder» de Google) o el enlace «Pedir reseñas» de tu
          perfil de empresa en Google. Si rellenas los dos, se usa el Place ID.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={placeId}
            onChange={(e) => setPlaceId(e.target.value)}
            placeholder="Place ID (ChIJ…)"
            className="border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://g.page/r/…/review"
            className="border border-gray-300 rounded px-2 py-1.5 text-sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            disabled={saving}
            onClick={() => save({ googlePlaceId: placeId, googleWriteReviewUrl: url })}
            className="bg-purple-600 text-white text-sm px-3 py-1.5 rounded hover:bg-purple-700 disabled:opacity-50"
          >
            Guardar
          </button>
          {settings.googleReviewLink ? (
            <a
              href={settings.googleReviewLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline"
            >
              <CheckCircle2 className="w-4 h-4" /> Probar el enlace <ExternalLink className="w-3 h-3" />
            </a>
          ) : (
            <span className="text-xs text-gray-500">Sin enlace: no se mostrará el botón de Google.</span>
          )}
        </div>
        {!settings.googleApi.available && (
          <p className="text-xs text-gray-500">
            Ver y responder tus reseñas de Google desde aquí no está disponible: necesita que Google
            apruebe el acceso a su API de Perfil de Empresa. Se responden desde tu perfil de Google.
          </p>
        )}
      </div>
    </div>
  );
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className="text-2xl font-semibold text-gray-900 mt-1">{value}</div>
      {hint && <div className="text-xs text-gray-500 mt-1">{hint}</div>}
    </div>
  );
}
