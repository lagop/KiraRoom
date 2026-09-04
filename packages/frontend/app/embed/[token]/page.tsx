"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import {
  Calendar,
  Clock,
  Scissors,
  User as UserIcon,
  Check,
  AlertCircle,
} from "lucide-react";

interface WidgetConfig {
  tenant: {
    id: string;
    name: string;
    slug: string;
    logo?: string;
    coverImage?: string;
    city?: string;
    country?: string;
    timezone: string;
    currency: string;
    language: string;
  };
  widget: {
    id: string;
    name: string;
    allowedOrigins: string[];
    theme: Record<string, any>;
  };
  services: Array<{
    id: string;
    name: string;
    description?: string;
    category: string;
    duration: number;
    price: number;
    currency: string;
    images: any;
  }>;
  professionals: Array<{
    id: string;
    firstName: string;
    lastName: string;
    bio?: string;
    profileImage?: string;
    specialties: any;
  }>;
}

interface Slot {
  time: string;
  available: boolean;
  professionalId?: string;
}

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api/v1";

export default function EmbedWidgetPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token as string;
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"select" | "details" | "done">("select");
  const [serviceId, setServiceId] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [time, setTime] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [bookingError, setBookingError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch(`${API}/embed/${token}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setConfig)
      .catch((err) => setError(err.message ?? "No se pudo cargar"));
  }, [token]);

  useEffect(() => {
    if (!config || !serviceId || !date) {
      setSlots([]);
      return;
    }
    const params = new URLSearchParams({
      tenantId: config.tenant.id,
      date,
      serviceId,
      duration: String(
        config.services.find((s) => s.id === serviceId)?.duration ?? 60,
      ),
    });
    if (professionalId) params.append("professionalId", professionalId);
    fetch(`${API}/appointments/available-slots?${params.toString()}`)
      .then(async (r) => (r.ok ? r.json() : []))
      .then((data: Slot[]) =>
        setSlots(data.filter((s: any) => s.isAvailable ?? s.available ?? true)),
      )
      .catch(() => setSlots([]));
  }, [config, serviceId, professionalId, date]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!config) return;
    setSubmitting(true);
    setBookingError(null);
    try {
      const [firstName, ...rest] = name.split(" ");
      const lastName = rest.join(" ") || firstName;
      const body = {
        tenantId: config.tenant.id,
        serviceId,
        professionalId,
        scheduledDate: date,
        scheduledTime: time,
        notes: notes || undefined,
        source: "widget",
        widgetInstanceId: config.widget.id,
        clientInfo: { firstName, lastName, email, phone: phone || undefined },
      };
      const res = await fetch(`${API}/appointments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message ?? `HTTP ${res.status}`);
      }
      const appt = await res.json();
      setBookingId(appt.id);
      setStep("done");
    } catch (err: any) {
      setBookingError(err.message ?? "Error");
    } finally {
      setSubmitting(false);
    }
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="bg-white rounded-xl p-6 shadow max-w-md w-full text-center">
          <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-3" />
          <h1 className="font-semibold text-gray-900">Widget no disponible</h1>
          <p className="text-sm text-gray-500 mt-2">
            El enlace puede haber sido revocado o nunca existió.
          </p>
        </div>
      </div>
    );
  }
  if (!config) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500">Cargando…</div>
      </div>
    );
  }

  const selectedService = config.services.find((s) => s.id === serviceId);

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-white">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center gap-3">
        {config.tenant.logo && (
          <img
            src={config.tenant.logo}
            alt={config.tenant.name}
            className="w-10 h-10 rounded-full object-cover"
          />
        )}
        <div>
          <h1 className="font-semibold text-gray-900">{config.tenant.name}</h1>
          <p className="text-xs text-gray-500">Reserva online</p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-6">
        {step === "select" && (
          <div className="space-y-6">
            <div>
              <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <Scissors className="w-4 h-4 text-purple-600" /> Servicio
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {config.services.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setServiceId(s.id)}
                    className={`text-left p-4 border rounded-lg transition ${
                      serviceId === s.id
                        ? "border-purple-500 bg-purple-50"
                        : "border-gray-200 hover:border-purple-300"
                    }`}
                  >
                    <div className="font-medium text-gray-900">{s.name}</div>
                    {s.description && (
                      <div className="text-xs text-gray-500 mt-1 line-clamp-2">
                        {s.description}
                      </div>
                    )}
                    <div className="flex items-center justify-between mt-2 text-sm">
                      <span className="text-gray-500">
                        <Clock className="inline w-3 h-3 mr-1" />
                        {s.duration} min
                      </span>
                      <span className="font-semibold text-purple-600">
                        {Number(s.price).toFixed(2)} {s.currency}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <UserIcon className="w-4 h-4 text-purple-600" /> Profesional
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <button
                  onClick={() => setProfessionalId("")}
                  className={`p-3 border rounded-lg text-sm transition ${
                    !professionalId
                      ? "border-purple-500 bg-purple-50"
                      : "border-gray-200 hover:border-purple-300"
                  }`}
                >
                  Cualquiera
                </button>
                {config.professionals.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setProfessionalId(p.id)}
                    className={`p-3 border rounded-lg text-sm transition ${
                      professionalId === p.id
                        ? "border-purple-500 bg-purple-50"
                        : "border-gray-200 hover:border-purple-300"
                    }`}
                  >
                    {p.firstName} {p.lastName}
                  </button>
                ))}
              </div>
            </div>

            {serviceId && (
              <div>
                <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-purple-600" /> Fecha y hora
                </h2>
                <input
                  type="date"
                  value={date}
                  min={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full md:w-1/3 border border-gray-300 rounded-lg px-3 py-2"
                />
                {date && (
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mt-3">
                    {slots.length === 0 && (
                      <div className="col-span-full text-sm text-gray-500">
                        No hay huecos disponibles este día.
                      </div>
                    )}
                    {slots.map((slot) => (
                      <button
                        key={slot.time}
                        onClick={() => {
                          setTime(slot.time);
                          setStep("details");
                        }}
                        className={`p-2 border rounded text-sm transition ${
                          time === slot.time
                            ? "border-purple-500 bg-purple-50"
                            : "border-gray-200 hover:border-purple-300"
                        }`}
                      >
                        {slot.time}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {step === "details" && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 text-sm">
              <strong>{selectedService?.name}</strong> · {time} · {date}
            </div>
            <input
              required
              placeholder="Nombre completo"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
            />
            <input
              required
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
            />
            <input
              type="tel"
              placeholder="Teléfono (opcional)"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
            />
            <textarea
              placeholder="Notas (opcional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
            />
            {bookingError && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
                {bookingError}
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setStep("select")}
                className="px-4 py-2 border border-gray-300 rounded-lg"
              >
                Atrás
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="flex-1 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 disabled:opacity-50"
              >
                {submitting ? "Enviando…" : "Confirmar reserva"}
              </button>
            </div>
          </form>
        )}

        {step === "done" && (
          <div className="text-center space-y-3 py-12">
            <Check className="w-12 h-12 text-green-600 mx-auto" />
            <h2 className="text-xl font-semibold text-gray-900">
              ¡Reserva registrada!
            </h2>
            <p className="text-sm text-gray-500">
              Te enviaremos un email de confirmación. Si el salón requiere firma de
              consentimiento, te llegará un enlace en los próximos minutos.
            </p>
            {bookingId && (
              <p className="text-xs text-gray-400">Ref: {bookingId.slice(0, 8)}</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}