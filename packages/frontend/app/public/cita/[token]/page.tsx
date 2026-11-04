"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AlertCircle, CalendarX, Check, Phone } from "lucide-react";
import { formatBookingDate } from "@/lib/public-booking";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

/** GET/POST /public/appointments/:token (backend public-appointment.controller.ts). */
interface CancelLinkInfo {
  state: "cancellable" | "too_late" | "cancelled" | "closed";
  canCancel: boolean;
  salonName: string;
  salonPhone: string | null;
  serviceName: string | null;
  professionalName: string | null;
  date: string;
  time: string;
  minCancelHours: number;
}

/**
 * "Cancelar mi cita": the page the link in the confirmation email or SMS of
 * an online booking opens. The client cancels without an account, outside
 * the salon's minimum notice; inside it she is asked to call the salon.
 * No rescheduling here.
 *
 * Opening it cancels nothing: mail scanners and link previews follow links,
 * so only the button does (POST).
 */
export default function CancelAppointmentPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token as string;
  const [info, setInfo] = useState<CancelLinkInfo | null>(null);
  const [error, setError] = useState<"invalid" | "generic" | null>(null);
  const [sending, setSending] = useState(false);
  const [justCancelled, setJustCancelled] = useState(false);

  useEffect(() => {
    fetch(`${API}/public/appointments/${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.status === 404) throw new Error("invalid");
        if (!r.ok) throw new Error("generic");
        return r.json();
      })
      .then((data: CancelLinkInfo) => setInfo(data))
      .catch((err) => setError(err.message === "invalid" ? "invalid" : "generic"));
  }, [token]);

  async function cancel() {
    setSending(true);
    try {
      const res = await fetch(`${API}/public/appointments/${encodeURIComponent(token)}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error(res.status === 404 ? "invalid" : "generic");
      const data = (await res.json()) as CancelLinkInfo;
      setInfo(data);
      if (data.state === "cancelled") setJustCancelled(true);
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
        <AlertCircle className="w-10 h-10 text-red-500 mx-auto" aria-hidden="true" />
        <h1 className="font-semibold">
          {error === "invalid" ? "Enlace no válido" : "Algo ha fallado"}
        </h1>
        <p className="text-sm text-gray-500">
          {error === "invalid"
            ? "Comprueba que has abierto el enlace completo del aviso. Si sigue fallando, llama al salón para cancelar la cita."
            : "Inténtalo de nuevo en un momento."}
        </p>
      </>,
    );
  }

  if (!info) {
    return shell(<p className="text-sm text-gray-500">Cargando…</p>);
  }

  const when = `${formatBookingDate(info.date)} a las ${info.time}`;
  const details = (
    <dl
      data-test="cancel-details"
      className="mx-auto grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 rounded-lg bg-gray-50 p-4 text-left text-sm"
    >
      <dt className="text-gray-500">Salón</dt>
      <dd className="font-medium text-gray-900">{info.salonName}</dd>
      {info.serviceName && (
        <>
          <dt className="text-gray-500">Servicio</dt>
          <dd className="font-medium text-gray-900">{info.serviceName}</dd>
        </>
      )}
      {info.professionalName && (
        <>
          <dt className="text-gray-500">Con</dt>
          <dd className="font-medium text-gray-900">{info.professionalName}</dd>
        </>
      )}
      <dt className="text-gray-500">Cuándo</dt>
      <dd className="font-medium text-gray-900">{when}</dd>
    </dl>
  );
  const callSalon = info.salonPhone ? (
    <a
      href={`tel:${info.salonPhone.replace(/\s+/g, "")}`}
      className="inline-flex items-center justify-center gap-2 w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-900 hover:bg-gray-50"
    >
      <Phone className="w-4 h-4" aria-hidden="true" />
      {info.salonPhone}
    </a>
  ) : null;

  if (info.state === "cancelled") {
    return shell(
      <div role="status" aria-live="polite" data-test="cancel-done" className="space-y-4">
        <Check className="w-12 h-12 text-green-600 mx-auto" aria-hidden="true" />
        <h1 className="text-xl font-semibold">
          {justCancelled ? "Tu cita está cancelada" : "Esta cita ya está cancelada"}
        </h1>
        {details}
        <p className="text-sm text-gray-600">
          {justCancelled
            ? `Hemos avisado a ${info.salonName}. Si quieres otra cita, puedes reservarla en su web o llamar al salón.`
            : "No tienes que hacer nada más."}
        </p>
      </div>,
    );
  }

  if (info.state === "too_late") {
    return shell(
      <div data-test="cancel-too-late" className="space-y-4">
        <Phone className="w-10 h-10 text-gray-500 mx-auto" aria-hidden="true" />
        <h1 className="text-xl font-semibold">Ya no se puede cancelar online</h1>
        {details}
        <p className="text-sm text-gray-600">
          {info.salonPhone
            ? `Ya no se puede cancelar online, llama al salón: ${info.salonPhone}.`
            : "Ya no se puede cancelar online: llama o escribe al salón."}
          {info.minCancelHours > 0 &&
            ` ${info.salonName} pide avisar con al menos ${info.minCancelHours} ${info.minCancelHours === 1 ? "hora" : "horas"} de antelación.`}
        </p>
        {callSalon}
      </div>,
    );
  }

  if (info.state === "closed") {
    return shell(
      <div data-test="cancel-closed" className="space-y-4">
        <CalendarX className="w-10 h-10 text-gray-500 mx-auto" aria-hidden="true" />
        <h1 className="text-xl font-semibold">Esta cita ya no se puede cancelar</h1>
        {details}
        <p className="text-sm text-gray-600">
          Ya ha pasado o el salón ya la ha cerrado. Si tienes cualquier duda, llama al salón.
        </p>
        {callSalon}
      </div>,
    );
  }

  return shell(
    <div data-test="cancel-ready" className="space-y-4">
      <CalendarX className="w-10 h-10 text-gray-500 mx-auto" aria-hidden="true" />
      <h1 className="text-xl font-semibold">¿Cancelar tu cita?</h1>
      {details}
      <p className="text-sm text-gray-600">
        Si la cancelas, el hueco queda libre para otra persona y avisaremos a {info.salonName}. Para cambiarla
        de día, cancélala y reserva otra, o llama al salón.
      </p>
      <button
        type="button"
        onClick={cancel}
        disabled={sending}
        data-test="cancel-confirm"
        className="w-full rounded-lg bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60"
      >
        {sending ? "Un momento…" : "Cancelar mi cita"}
      </button>
    </div>,
  );
}
