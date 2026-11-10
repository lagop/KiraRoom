"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { AlertCircle, CalendarX, Check, CreditCard, Loader2, Phone } from "lucide-react";
import { formatBookingDate } from "@/lib/public-booking";
import { euros, paymentReturn, safeCheckoutUrl } from "@/lib/booking-payment";

const API =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

/** GET/POST /public/appointments/:token (backend public-appointment.controller.ts). */
interface CancelLinkInfo {
  state: "cancellable" | "too_late" | "cancelled" | "closed" | "awaiting_payment" | "paid_online";
  canCancel: boolean;
  salonName: string;
  salonPhone: string | null;
  serviceName: string | null;
  professionalName: string | null;
  date: string;
  time: string;
  minCancelHours: number;
  /** Online payment at booking: held while she pays, paid, or none. */
  payment: {
    state: "none" | "awaiting" | "paid";
    kind: "deposit" | "full" | null;
    amountCents: number | null;
    holdUntil: string | null;
  };
}

/** How long (ms) and how often the page asks again after she paid, until Stripe's notice arrives. */
const POLL_EVERY_MS = 3000;
const POLL_TIMES = 20;

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
  // Back from Stripe: "ok" (she paid, the notice may still be on its way) or "cancelado".
  const [back, setBack] = useState<"ok" | "cancelado" | null>(null);
  const [polls, setPolls] = useState(0);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  // She let go of a booking that was only held: nothing was charged, nobody was told.
  const [releasedHold, setReleasedHold] = useState(false);

  useEffect(() => {
    setBack(paymentReturn(window.location.search));
  }, []);

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

  // She paid and came back: the confirmation is Stripe's notice to the server,
  // which can be a few seconds behind her. Ask again until the booking is real.
  useEffect(() => {
    if (back !== "ok" || info?.state !== "awaiting_payment" || polls >= POLL_TIMES) return;
    const timer = window.setTimeout(async () => {
      try {
        const r = await fetch(`${API}/public/appointments/${encodeURIComponent(token)}`);
        if (r.ok) setInfo((await r.json()) as CancelLinkInfo);
      } finally {
        setPolls((n) => n + 1);
      }
    }, POLL_EVERY_MS);
    return () => window.clearTimeout(timer);
  }, [back, info?.state, polls, token]);

  async function payNow() {
    setPaying(true);
    setPayError(null);
    try {
      const res = await fetch(`${API}/public/appointments/${encodeURIComponent(token)}/pay`, { method: "POST" });
      if (res.status === 410) {
        setPayError("El tiempo para pagar ha terminado y el hueco se ha liberado. Vuelve a reservar.");
        setPaying(false);
        return;
      }
      if (!res.ok) throw new Error("generic");
      const url = safeCheckoutUrl(((await res.json()) as { checkoutUrl?: string }).checkoutUrl);
      if (!url) throw new Error("generic");
      window.location.assign(url);
    } catch {
      setPayError("No se ha podido abrir el pago. Inténtalo de nuevo en un momento.");
      setPaying(false);
    }
  }

  async function cancel() {
    setSending(true);
    try {
      const res = await fetch(`${API}/public/appointments/${encodeURIComponent(token)}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error(res.status === 404 ? "invalid" : "generic");
      const data = (await res.json()) as CancelLinkInfo;
      if (info?.state === "awaiting_payment" && data.state === "cancelled") setReleasedHold(true);
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
          {error === "invalid" ? (back ? "Esta reserva ya no está guardada" : "Enlace no válido") : "Algo ha fallado"}
        </h1>
        <p className="text-sm text-gray-500">
          {error === "invalid"
            ? back
              ? "El tiempo para pagar terminó y el hueco se liberó. Si pagaste, te devolvemos el importe automáticamente. Puedes volver a reservar."
              : "Comprueba que has abierto el enlace completo del aviso. Si sigue fallando, llama al salón para cancelar la cita."
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

  const amount = info.payment.amountCents ? euros(info.payment.amountCents) : "";
  const what = info.payment.kind === "full" ? "el servicio completo" : "la señal";

  if (info.state === "awaiting_payment") {
    // Back from the payment page and waiting for Stripe's notice to reach us.
    if (back === "ok") {
      const gaveUp = polls >= POLL_TIMES;
      return shell(
        <div role="status" aria-live="polite" data-test="payment-confirming" className="space-y-4">
          {gaveUp ? (
            <AlertCircle className="w-10 h-10 text-amber-500 mx-auto" aria-hidden="true" />
          ) : (
            <Loader2 className="w-10 h-10 text-purple-600 mx-auto animate-spin" aria-hidden="true" />
          )}
          <h1 className="text-xl font-semibold">
            {gaveUp ? "Todavía no vemos tu pago" : "Estamos confirmando tu pago…"}
          </h1>
          {details}
          <p className="text-sm text-gray-600">
            {gaveUp
              ? "Si has pagado, la confirmación puede tardar unos minutos: te llegará por email. Si no ha llegado, llama al salón."
              : "Un momento, no cierres esta página."}
          </p>
          {gaveUp && callSalon}
        </div>,
      );
    }
    const until = info.payment.holdUntil
      ? new Date(info.payment.holdUntil).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
      : null;
    return shell(
      <div data-test="payment-pending" className="space-y-4">
        <CreditCard className="w-10 h-10 text-purple-600 mx-auto" aria-hidden="true" />
        <h1 className="text-xl font-semibold">
          {back === "cancelado" ? "No has completado el pago" : "Falta tu pago para confirmar la reserva"}
        </h1>
        {details}
        <p className="text-sm text-gray-600">
          Tu reserva queda confirmada al pagar {what}
          {amount ? ` (${amount})` : ""}.{until ? ` Te guardamos el hueco hasta las ${until}.` : ""}
        </p>
        {payError && (
          <p role="alert" className="text-sm text-red-600">
            {payError}
          </p>
        )}
        <button
          type="button"
          onClick={payNow}
          disabled={paying || sending}
          data-test="payment-pay"
          className="w-full rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-60"
        >
          {paying ? "Abriendo el pago…" : amount ? `Pagar ${amount}` : "Pagar"}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={paying || sending}
          data-test="payment-release"
          className="w-full rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-900 hover:bg-gray-50 disabled:opacity-60"
        >
          {sending ? "Un momento…" : "No quiero esta reserva"}
        </button>
      </div>,
    );
  }

  if (info.state === "paid_online") {
    return shell(
      <div data-test="paid-online" className="space-y-4">
        <Check className="w-12 h-12 text-green-600 mx-auto" aria-hidden="true" />
        <h1 className="text-xl font-semibold">
          {back === "ok" ? "¡Pago recibido! Tu reserva está hecha" : "Tu reserva tiene un pago online"}
        </h1>
        {details}
        <p className="text-sm text-gray-600">
          Has pagado {what}
          {amount ? ` (${amount})` : ""}.{" "}
          {info.payment.kind === "deposit" ? "El resto lo pagas en el salón. " : ""}
          Para cancelar o cambiar una cita con pago, contacta con {info.salonName}.
        </p>
        {callSalon}
      </div>,
    );
  }

  if (info.state === "cancelled") {
    return shell(
      <div role="status" aria-live="polite" data-test="cancel-done" className="space-y-4">
        <Check className="w-12 h-12 text-green-600 mx-auto" aria-hidden="true" />
        <h1 className="text-xl font-semibold">
          {releasedHold
            ? "Reserva descartada"
            : justCancelled
              ? "Tu cita está cancelada"
              : "Esta cita ya está cancelada"}
        </h1>
        {details}
        <p className="text-sm text-gray-600">
          {releasedHold
            ? "Hemos liberado el hueco y no se te ha cobrado nada. Si quieres otra cita, puedes reservarla en su web."
            : justCancelled
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
