"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Check, AlertCircle, MailX } from "lucide-react";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

/**
 * The page the unsubscribe link of KiraRoom's tips to salon owners opens
 * (the day-2 onboarding reminder, audit 7 D17).
 *
 * Opening it does not unsubscribe: mail scanners follow links, so only the
 * button does (POST). The same POST is what a mail client's own
 * "unsubscribe" button sends (RFC 8058).
 */
export default function TipsUnsubscribePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token as string;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<"invalid" | "generic" | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const url = `${API}/public/email/tips-unsubscribe/${encodeURIComponent(token)}`;

  useEffect(() => {
    fetch(url)
      .then(async (r) => {
        if (r.status === 404) throw new Error("invalid");
        if (!r.ok) throw new Error("generic");
        return r.json();
      })
      .then((data: { unsubscribed: boolean }) => {
        if (data.unsubscribed) setDone(true);
        setLoaded(true);
      })
      .catch((err) => setError(err.message === "invalid" ? "invalid" : "generic"));
  }, [url]);

  async function unsubscribe() {
    setSending(true);
    try {
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) throw new Error(res.status === 404 ? "invalid" : "generic");
      setDone(true);
    } catch (err) {
      setError((err as Error).message === "invalid" ? "invalid" : "generic");
    } finally {
      setSending(false);
    }
  }

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
      <div className="bg-white rounded-xl p-8 shadow max-w-md w-full text-center space-y-4">{children}</div>
    </div>
  );

  if (error) {
    return shell(
      <>
        <AlertCircle className="w-10 h-10 text-red-500 mx-auto" />
        <h1 className="font-semibold">{error === "invalid" ? "Enlace no válido" : "Algo ha fallado"}</h1>
        <p className="text-sm text-gray-500">
          {error === "invalid"
            ? "Comprueba que has abierto el enlace completo del email. Si sigue fallando, responde al email y pide que no te enviemos más consejos."
            : "Inténtalo de nuevo en un momento."}
        </p>
      </>,
    );
  }

  if (!loaded && !done) {
    return shell(<p className="text-sm text-gray-500">Cargando…</p>);
  }

  if (done) {
    return shell(
      <>
        <Check className="w-12 h-12 text-green-600 mx-auto" />
        <h1 className="text-xl font-semibold">No te enviaremos más consejos</h1>
        <p className="text-sm text-gray-600">
          Seguirás recibiendo los emails necesarios de tu cuenta, como las facturas de KiraRoom, los avisos de tu
          suscripción y los de las reservas de tu salón.
        </p>
      </>,
    );
  }

  return shell(
    <>
      <MailX className="w-10 h-10 text-gray-500 mx-auto" />
      <h1 className="text-xl font-semibold">¿Dejar de recibir consejos de KiraRoom?</h1>
      <p className="text-sm text-gray-600">
        No te enviaremos más recordatorios para terminar de configurar tu salón. Los emails necesarios de tu cuenta
        seguirán llegando.
      </p>
      <button
        type="button"
        onClick={unsubscribe}
        disabled={sending}
        className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
      >
        {sending ? "Un momento…" : "Darme de baja"}
      </button>
    </>,
  );
}
