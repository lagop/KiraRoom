"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Star, ExternalLink, Check, AlertCircle } from "lucide-react";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

interface ReviewData {
  tenant: { name: string; slug: string; logo?: string | null } | null;
  professional?: { firstName: string } | null;
  service?: { name: string } | null;
  googleReviewLink?: string | null;
  submitted: boolean;
  rating: number | null;
  goodRating: number;
}

/**
 * The page a client reaches from the post-visit review request.
 *
 * The Google button is offered to everyone who answers, not only to happy
 * clients: Google's policy forbids soliciting reviews selectively, so it is
 * only made more prominent for a good rating.
 */
export default function PublicReviewPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token as string;
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<"invalid" | "expired" | "generic" | null>(null);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [optOutMode, setOptOutMode] = useState(false);
  const [optedOut, setOptedOut] = useState(false);

  // The opt-out link in the email is this page with ?baja=1.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("baja") === "1") setOptOutMode(true);
  }, []);

  useEffect(() => {
    fetch(`${API}/public/r/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.status === 410) throw new Error("expired");
        if (!r.ok) throw new Error("invalid");
        return r.json();
      })
      .then(setData)
      .catch((err) => setError(err.message === "expired" ? "expired" : "invalid"));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (rating < 1) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/public/r/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, comment: comment.trim() || undefined }),
      });
      if (res.status === 410) throw new Error("expired");
      if (!res.ok && res.status !== 409) throw new Error("generic");
      setData((d) => (d ? { ...d, submitted: true, rating } : d));
    } catch (err: any) {
      setError(err.message === "expired" ? "expired" : "generic");
    } finally {
      setSubmitting(false);
    }
  }

  function openGoogle() {
    // Fire-and-forget: the click is counted, the link opens regardless.
    fetch(`${API}/public/r/${encodeURIComponent(token)}/google-click`, {
      method: "POST",
      keepalive: true,
    }).catch(() => undefined);
  }

  async function optOut() {
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/public/r/${encodeURIComponent(token)}/opt-out`, {
        method: "POST",
      });
      if (!res.ok) throw new Error("generic");
      setOptedOut(true);
    } catch {
      setOptOutMode(false);
      setError("generic");
    } finally {
      setSubmitting(false);
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
      <div className="bg-white rounded-xl p-8 shadow max-w-md w-full text-center space-y-4">
        {children}
      </div>
    </div>
  );

  if (optedOut) {
    return shell(
      <>
        <Check className="w-12 h-12 text-green-600 mx-auto" />
        <h1 className="text-xl font-semibold">Hecho</h1>
        <p className="text-sm text-gray-500">
          No te volveremos a pedir tu opinión
          {data?.tenant ? ` de parte de ${data.tenant.name}` : ""}. Tus citas y
          recordatorios siguen igual.
        </p>
      </>,
    );
  }

  if (optOutMode && error !== "invalid") {
    return shell(
      <>
        <h1 className="text-xl font-semibold">¿Dejamos de pedirte tu opinión?</h1>
        <p className="text-sm text-gray-500">
          No recibirás más mensajes pidiéndote que valores tus visitas
          {data?.tenant ? ` a ${data.tenant.name}` : ""}.
        </p>
        <button
          onClick={optOut}
          disabled={submitting}
          className="w-full bg-gray-900 text-white py-2.5 rounded-lg disabled:opacity-50"
        >
          Sí, no quiero más peticiones
        </button>
        <button onClick={() => setOptOutMode(false)} className="text-sm text-gray-500 underline">
          Volver
        </button>
      </>,
    );
  }

  if (error) {
    return shell(
      <>
        <AlertCircle className="w-10 h-10 text-red-500 mx-auto" />
        <h1 className="font-semibold">
          {error === "expired" ? "Este enlace ha caducado" : error === "invalid" ? "Enlace no válido" : "Algo ha fallado"}
        </h1>
        <p className="text-sm text-gray-500">
          {error === "generic"
            ? "Inténtalo de nuevo en un momento."
            : "Los enlaces para valorar una visita duran 14 días."}
        </p>
      </>,
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-500">
        Cargando…
      </div>
    );
  }

  const salon = data.tenant?.name ?? "el salón";

  if (data.submitted) {
    const good = (data.rating ?? 0) >= data.goodRating;
    return shell(
      <>
        <Check className="w-12 h-12 text-green-600 mx-auto" />
        <h1 className="text-xl font-semibold">¡Gracias por tu opinión!</h1>
        <p className="text-sm text-gray-500">
          {salon} la leerá. Si la aprueba, podrá aparecer en su página de reservas
          con tu nombre y la inicial de tu apellido.
        </p>
        {data.googleReviewLink &&
          (good ? (
            <div className="space-y-2">
              <p className="text-sm text-gray-700">
                ¿Nos ayudas a que más gente nos conozca? Deja también tu reseña en Google:
              </p>
              <a
                href={data.googleReviewLink}
                target="_blank"
                rel="noreferrer"
                onClick={openGoogle}
                className="inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg"
              >
                <ExternalLink className="w-4 h-4" /> Escribir mi reseña en Google
              </a>
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              Si quieres, también puedes{" "}
              <a
                href={data.googleReviewLink}
                target="_blank"
                rel="noreferrer"
                onClick={openGoogle}
                className="text-blue-700 underline"
              >
                dejar tu reseña en Google
              </a>
              .
            </p>
          ))}
      </>,
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-white p-6">
      <div className="max-w-md mx-auto bg-white rounded-2xl shadow p-6 space-y-5">
        <div className="text-center">
          {data.tenant?.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.tenant.logo}
              alt={salon}
              className="w-14 h-14 mx-auto rounded-full object-cover mb-2"
            />
          ) : null}
          <h1 className="text-xl font-semibold text-gray-900">
            ¿Qué tal tu visita a {salon}?
          </h1>
          {(data.service || data.professional) && (
            <p className="text-sm text-gray-500">
              {data.service?.name}
              {data.service && data.professional ? " · " : ""}
              {data.professional ? `con ${data.professional.firstName}` : ""}
            </p>
          )}
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div className="flex items-center justify-center gap-1" role="radiogroup" aria-label="Valoración">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`${n} estrella${n === 1 ? "" : "s"}`}
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
            maxLength={2000}
            placeholder="Cuéntanos qué tal la experiencia (opcional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="w-full border border-gray-300 rounded-lg p-3 text-sm"
          />

          <p className="text-xs text-gray-500">
            {salon} revisa las opiniones antes de mostrarlas en su página de
            reservas, con tu nombre y la inicial de tu apellido.
          </p>

          <button
            type="submit"
            disabled={rating < 1 || submitting}
            className="w-full bg-purple-600 text-white py-2.5 rounded-lg hover:bg-purple-700 disabled:opacity-50"
          >
            {submitting ? "Enviando…" : "Enviar"}
          </button>
        </form>

        <div className="text-center">
          <button onClick={() => setOptOutMode(true)} className="text-xs text-gray-400 underline">
            No quiero que me pidáis más opiniones
          </button>
        </div>
      </div>
    </div>
  );
}
