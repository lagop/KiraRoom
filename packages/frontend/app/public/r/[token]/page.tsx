"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Star, ExternalLink, Check, AlertCircle } from "lucide-react";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

interface ReviewData {
  tenant: { id: string; name: string; slug: string; logo?: string };
  professional?: { firstName: string; lastName: string };
  service?: { name: string };
  googleReviewLink?: string | null;
}

export default function PublicReviewPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token as string;
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [publishGoogle, setPublishGoogle] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`${API}/public/r/${token}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((err) => setError(err.message ?? "Error"));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating < 1) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/public/r/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, comment, publishToGoogle: publishGoogle }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDone(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
        <div className="bg-white rounded-xl p-6 shadow max-w-md w-full text-center">
          <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-3" />
          <h1 className="font-semibold">Enlace no válido</h1>
          <p className="text-sm text-gray-500 mt-2">
            Este enlace puede haber expirado (14 días) o ya fue utilizado.
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        Cargando…
      </div>
    );
  }

  if (done) {
    if (publishGoogle && data.googleReviewLink) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
          <div className="bg-white rounded-xl p-8 shadow max-w-md w-full text-center space-y-4">
            <Check className="w-12 h-12 text-green-600 mx-auto" />
            <h1 className="text-xl font-semibold">¡Gracias por tu opinión!</h1>
            <p className="text-sm text-gray-500">
              Hemos guardado tu reseña. Para que también aparezca en Google,
              pulsa el botón — Google verificará tu cuenta y la publicará.
            </p>
            <a
              href={data.googleReviewLink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg"
            >
              <ExternalLink className="w-4 h-4" /> Publicar también en Google
            </a>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
        <div className="bg-white rounded-xl p-8 shadow max-w-md w-full text-center space-y-3">
          <Check className="w-12 h-12 text-green-600 mx-auto" />
          <h1 className="text-xl font-semibold">¡Gracias!</h1>
          <p className="text-sm text-gray-500">
            Tu reseña ha quedado registrada en {data.tenant.name}.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-white p-6">
      <div className="max-w-md mx-auto bg-white rounded-2xl shadow p-6 space-y-5">
        <div className="text-center">
          {data.tenant.logo ? (
            <img
              src={data.tenant.logo}
              alt={data.tenant.name}
              className="w-14 h-14 mx-auto rounded-full object-cover mb-2"
            />
          ) : null}
          <h1 className="text-xl font-semibold text-gray-900">
            ¿Cómo fue tu visita en {data.tenant.name}?
          </h1>
          {data.service && (
            <p className="text-sm text-gray-500">Servicio: {data.service.name}</p>
          )}
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center justify-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRating(n)}
                onMouseEnter={() => setHover(n)}
                onMouseLeave={() => setHover(0)}
              >
                <Star
                  className={`w-9 h-9 transition ${
                    n <= (hover || rating)
                      ? "fill-yellow-400 text-yellow-400"
                      : "text-gray-300"
                  }`}
                />
              </button>
            ))}
          </div>

          <textarea
            rows={4}
            placeholder="Cuéntanos qué tal la experiencia (opcional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="w-full border border-gray-300 rounded-lg p-3 text-sm"
          />

          {data.googleReviewLink && (
            <label className="flex items-start gap-2 text-sm text-gray-700 bg-gray-50 p-3 rounded-lg">
              <input
                type="checkbox"
                checked={publishGoogle}
                onChange={(e) => setPublishGoogle(e.target.checked)}
                className="mt-1"
              />
              <span>
                Publicar también en Google (recomendado). Google verificará tu
                cuenta antes de publicar.
              </span>
            </label>
          )}

          <button
            type="submit"
            disabled={rating < 1 || submitting}
            className="w-full bg-purple-600 text-white py-2.5 rounded-lg hover:bg-purple-700 disabled:opacity-50"
          >
            {submitting ? "Enviando…" : "Enviar reseña"}
          </button>
        </form>
      </div>
    </div>
  );
}