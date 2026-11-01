"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AlertCircle, Check, ListX } from "lucide-react";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

interface LinkInfo {
  salonName: string;
  serviceName: string;
  /** False once the entry is closed (she left, booked, or it expired). */
  waiting: boolean;
}

/**
 * "Ya no me interesa": the page the link in a wait-list notice (email or
 * SMS) opens. The client leaves the salon's wait list without an account.
 *
 * Opening it does not remove anyone: mail scanners and link previews follow
 * links, so only the button does (POST).
 */
export default function LeaveWaitListPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token as string;
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<"invalid" | "generic" | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(`${API}/public/wait-list/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.status === 404) throw new Error("invalid");
        if (!r.ok) throw new Error("generic");
        return r.json();
      })
      .then((data: LinkInfo) => {
        setInfo(data);
        if (!data.waiting) setDone(true);
      })
      .catch((err) => setError(err.message === "invalid" ? "invalid" : "generic"));
  }, [token]);

  async function leave() {
    setSending(true);
    try {
      const res = await fetch(`${API}/public/wait-list/${encodeURIComponent(token)}`, { method: "POST" });
      if (!res.ok) throw new Error(res.status === 404 ? "invalid" : "generic");
      setInfo((await res.json()) as LinkInfo);
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
            ? "Comprueba que has abierto el enlace completo del aviso. Si sigue fallando, contesta al aviso o llama al salón y pide que te quiten de la lista."
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
        <h1 className="text-xl font-semibold">Ya no estás en la lista de espera</h1>
        <p className="text-sm text-gray-600">
          {info.salonName} no te avisará más de huecos libres para {info.serviceName}. Si cambias de
          idea, puedes reservar en su web o pedir que te apunten otra vez.
        </p>
      </>,
    );
  }

  return shell(
    <>
      <ListX className="w-10 h-10 text-gray-500 mx-auto" />
      <h1 className="text-xl font-semibold">¿Ya no te interesa?</h1>
      <p className="text-sm text-gray-600">
        Estás en la lista de espera de <strong>{info.salonName}</strong> para{" "}
        <strong>{info.serviceName}</strong>. Si sales, no te avisaremos más cuando se libere un hueco.
      </p>
      <button
        type="button"
        onClick={leave}
        disabled={sending}
        className="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
      >
        {sending ? "Un momento…" : "Salir de la lista de espera"}
      </button>
    </>,
  );
}
