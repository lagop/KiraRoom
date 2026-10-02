"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Check, AlertCircle, MailX } from "lucide-react";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

interface LinkInfo {
  salonName: string;
  /** Masked, e.g. "an•••@example.com". */
  email: string;
  unsubscribed: boolean;
}

/**
 * The page the unsubscribe link of a salon's marketing emails opens.
 *
 * Opening it does not unsubscribe: mail scanners follow links, so only the
 * button does (POST). The same POST is what a mail client's own
 * "unsubscribe" button sends (RFC 8058).
 */
export default function UnsubscribePage() {
  const params = useParams<{ token: string }>();
  const token = params?.token as string;
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<"invalid" | "generic" | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`${API}/public/email/unsubscribe/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.status === 404) throw new Error("invalid");
        if (!r.ok) throw new Error("generic");
        return r.json();
      })
      .then((data: LinkInfo) => {
        setInfo(data);
        if (data.unsubscribed) setDone(true);
      })
      .catch((err) => setError(err.message === "invalid" ? "invalid" : "generic"));
  }, [token]);

  async function unsubscribe() {
    setSending(true);
    try {
      const res = await fetch(`${API}/public/email/unsubscribe/${encodeURIComponent(token)}`, {
        method: "POST",
      });
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
      <div className="bg-white rounded-xl p-8 shadow max-w-md w-full text-center space-y-4">
        {children}
      </div>
    </div>
  );

  if (error) {
    return shell(
      <>
        <AlertCircle className="w-10 h-10 text-red-500 mx-auto" />
        <h1 className="font-semibold">
          {error === "invalid" ? "Enlace no válido" : "Algo ha fallado"}
        </h1>
        <p className="text-sm text-gray-500">
          {error === "invalid"
            ? "Comprueba que has abierto el enlace completo del email. Si sigue fallando, responde al email y pide que no te envíen más."
            : "Inténtalo de nuevo en un momento."}
        </p>
      </>,
    );
  }

  if (!info) {
    return shell(<p className="text-sm text-gray-500">Cargando…</p>);
  }

  if (done) {
    return shell(
      <>
        <Check className="w-12 h-12 text-green-600 mx-auto" />
        <h1 className="text-xl font-semibold">Te has dado de baja</h1>
        <p className="text-sm text-gray-600">
          {info.salonName} no te enviará más emails de promociones a {info.email}. Seguirás
          recibiendo los avisos de tus citas, como las confirmaciones y los recordatorios.
        </p>
      </>,
    );
  }

  return shell(
    <>
      <MailX className="w-10 h-10 text-gray-500 mx-auto" />
      <h1 className="text-xl font-semibold">¿Dejar de recibir promociones?</h1>
      <p className="text-sm text-gray-600">
        Dejarás de recibir los emails de promociones y novedades de{" "}
        <strong>{info.salonName}</strong> en {info.email}. Los avisos de tus citas seguirán
        llegando.
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
