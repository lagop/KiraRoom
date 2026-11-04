"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  Calendar,
  Clock,
  Scissors,
  User as UserIcon,
  Check,
  AlertCircle,
  MapPin,
  Phone,
} from "lucide-react";
import { formatPrice, priceOnRequest, publicImageSrc, type PublicSalonLocation } from "@/lib/salon-seo";
import { postEmbedHeight } from "@/lib/embed-snippet";
import {
  BOOKING_CHOICE_TEXT,
  bookingErrorMessage,
  formatBookingDate,
  isBeyondWindow,
  localDateString,
  privacyPolicyUrl,
  splitClientName,
  whatsappPromotionsLabel,
} from "@/lib/public-booking";
import {
  bookingLocations,
  choiceAtLocation,
  chosenLocation,
  confirmedPlace,
  locationForProfessional,
  locationFromQuery,
  locationReady,
  professionalsAtLocation,
  professionalsForService,
  servicesAtLocation,
} from "@/lib/public-booking-locations";

interface WidgetConfig {
  tenant: {
    id: string;
    name: string;
    slug: string;
    /** URLs (publicImageSrc), never the uploaded data: URLs. */
    logoUrl?: string | null;
    coverImageUrl?: string | null;
    /** Shown instead of the steps while the salon takes no bookings. */
    phone?: string | null;
    city?: string;
    country?: string;
    timezone: string;
    currency: string;
    language: string;
    /**
     * The tax the service prices include (IVA, IGIC, IPSI): prices are
     * final. Absent from servers older than final prices.
     */
    taxLabel?: string;
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
    /** Which services they do (absent from older servers). */
    services?: Array<{ serviceId: string }>;
    /** Where they work, when the salon has locations to pick from. */
    locationIds?: string[];
    primaryLocationId?: string | null;
  }>;
  /**
   * Two or more locations to book at (multi-local), as on the public booking
   * page: the client picks one, or it follows from the professional. Empty
   * or absent for a salon with one location: no location step.
   */
  locations?: PublicSalonLocation[];
  /**
   * The salon has its WhatsApp number connected: the form offers
   * "Recibir los avisos de mi cita por WhatsApp". Absent from older servers.
   */
  whatsappNotices?: boolean;
  /**
   * ...and its plan includes WhatsApp campaigns: the form offers the
   * optional WhatsApp promotions box. Absent from older servers.
   */
  whatsappPromotions?: boolean;
  /**
   * False while the salon is read-only (trial ended, cancelled, suspended):
   * the widget gives its phone instead of the steps. Absent from older
   * servers (= true).
   */
  acceptsBookings?: boolean;
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
  // One of the salon's locations, when it has several (lib/public-booking-locations.ts).
  const [locationId, setLocationId] = useState("");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  // Bumped to ask for the slots again (after a failed booking).
  const [slotsRefresh, setSlotsRefresh] = useState(0);
  // The visitor's calendar day, set after mount (not the server's UTC one).
  const [today, setToday] = useState("");
  const [time, setTime] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  // The two boxes, both unticked (BOOKING_CHOICE_TEXT).
  const [refusesMarketingEmail, setRefusesMarketingEmail] = useState(false);
  const [wantsWhatsAppNotices, setWantsWhatsAppNotices] = useState(false);
  // Optional, never pre-ticked (config.whatsappPromotions).
  const [wantsWhatsAppPromotions, setWantsWhatsAppPromotions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [bookingId, setBookingId] = useState<string | null>(null);
  // Where the server booked it (POST /appointments answers with the location).
  const [bookedPlace, setBookedPlace] = useState<{ name: string; address: string } | null>(null);
  const [bookingError, setBookingError] = useState<string | null>(null);
  // The last day the chosen service can be booked online (GET
  // /appointments/booking-window): the date picker stops there.
  const [bookingWindow, setBookingWindow] = useState<{ serviceId: string; lastDay: string } | null>(null);
  const lastDay = bookingWindow && bookingWindow.serviceId === serviceId ? bookingWindow.lastDay : null;
  // What the widget shows, measured for the salon's page (postEmbedHeight).
  const contentRef = useRef<HTMLDivElement | null>(null);

  // The salon's site sizes the iframe to the widget (the snippet's script,
  // lib/embed-snippet.ts): it is told the height, a bare number, on every
  // change. Without it a fixed 640 px put a scroll inside the page's scroll.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof window === "undefined" || window.parent === window) return;
    const send = () => postEmbedHeight(window.parent, el.getBoundingClientRect().height);
    send();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(send);
    observer.observe(el);
    return () => observer.disconnect();
  }, [config, error]);

  // The tab and screen readers name the widget after the salon.
  useEffect(() => {
    if (config?.tenant.name) document.title = `Reservar en ${config.tenant.name}`;
  }, [config?.tenant.name]);

  useEffect(() => {
    if (!token) return;
    fetch(`${API}/embed/${token}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: WidgetConfig) => {
        setConfig(data);
        // ?locationId=<id> or ?location=<slug> on the embed URL: that location.
        const linked = locationFromQuery(new URLSearchParams(window.location.search), bookingLocations(data));
        if (linked) setLocationId(linked);
      })
      .catch((err) => setError(err.message ?? "No se pudo cargar"));
  }, [token]);

  // The locations to choose from: none unless the salon has two or more.
  const locations = config ? bookingLocations(config) : [];

  useEffect(() => {
    setToday(localDateString());
  }, []);

  // A time belongs to the service, professional and day it was offered for:
  // changing any of them drops it, or the old time went out with the new ones.
  useEffect(() => {
    setTime("");
  }, [serviceId, professionalId, date, locationId]);

  useEffect(() => {
    if (!config || !serviceId) return;
    let cancelled = false;
    const q = new URLSearchParams({ tenantId: config.tenant.id, serviceId });
    fetch(`${API}/appointments/booking-window?${q.toString()}`)
      .then(async (r) => (r.ok ? r.json() : null))
      .then((w) => {
        if (!cancelled && w?.lastDay) setBookingWindow({ serviceId, lastDay: w.lastDay });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [config, serviceId]);

  useEffect(() => {
    setSlots([]);
    if (
      !config ||
      !serviceId ||
      !date ||
      !locationReady(bookingLocations(config), locationId) ||
      // Too far ahead: the message says so, nothing to ask.
      isBeyondWindow(date, lastDay)
    ) {
      setSlotsLoading(false);
      return;
    }
    let cancelled = false;
    setSlotsLoading(true);
    const params = new URLSearchParams({
      tenantId: config.tenant.id,
      date,
      serviceId,
      duration: String(
        config.services.find((s) => s.id === serviceId)?.duration ?? 60,
      ),
    });
    if (professionalId) params.append("professionalId", professionalId);
    // "Cualquiera": only this widget's professionals, as the booking assigns.
    else params.append("widgetInstanceId", config.widget.id);
    // At that location (multi-local): only the times of who works there.
    if (locationId) params.append("locationId", locationId);
    fetch(`${API}/appointments/available-slots?${params.toString()}`)
      .then(async (r) => (r.ok ? r.json() : []))
      .then((data: Slot[]) => {
        if (cancelled) return;
        const free = data.filter((s: any) => s.isAvailable ?? s.available ?? true);
        setSlots(free);
        // Keep a picked time only while it is still free.
        setTime((prev) => (prev && !free.some((s) => s.time === prev) ? "" : prev));
      })
      .catch(() => {
        if (!cancelled) setSlots([]);
      })
      .finally(() => {
        if (!cancelled) setSlotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [config, serviceId, professionalId, date, locationId, slotsRefresh, lastDay]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!config || !time) return;
    setSubmitting(true);
    setBookingError(null);
    try {
      // "Ana" is Ana with no last name, not "Ana Ana".
      const { firstName, lastName } = splitClientName(name);
      const body = {
        tenantId: config.tenant.id,
        serviceId,
        professionalId,
        scheduledDate: date,
        scheduledTime: time,
        notes: notes || undefined,
        source: "widget",
        widgetInstanceId: config.widget.id,
        // The location she picked, when the salon has several.
        ...(locationId ? { locationId } : {}),
        // The phone is required (the salon's way to reach the client about a
        // change); the email is optional.
        clientInfo: { firstName, lastName, phone, email: email.trim() || undefined },
        // Only what she ticked: an unticked box sends nothing.
        ...(refusesMarketingEmail ? { refusesMarketingEmail: true } : {}),
        ...(config.whatsappNotices && wantsWhatsAppNotices ? { wantsWhatsAppNotices: true } : {}),
        ...(config.whatsappPromotions && wantsWhatsAppPromotions ? { wantsWhatsAppPromotions: true } : {}),
      };
      const res = await fetch(`${API}/appointments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        // In Spanish, without NestJS's field path ("clientInfo.").
        throw new Error(bookingErrorMessage(err.message) || `HTTP ${res.status}`);
      }
      const appt = await res.json();
      setBookingId(appt.id);
      setBookedPlace(confirmedPlace(bookingLocations(config), locationId, appt));
      setStep("done");
    } catch (err: any) {
      setBookingError(err.message || "No se pudo reservar la cita. Inténtalo de nuevo.");
      // The slot may have been taken meanwhile: ask again, and a time no
      // longer free is dropped (see the slots effect).
      setSlotsRefresh((n) => n + 1);
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
  // With a location step: only what can be booked at the chosen location
  // (before one is chosen, every service and whoever works at any of them).
  const servicesHere = servicesAtLocation(config.services, config.professionals, locations, locationId);
  // Who does the chosen service (as on the salon's page): picking one who
  // does not only ever showed "No hay huecos".
  const professionalsAtHere = professionalsAtLocation(config.professionals, locations, locationId);
  const professionalsHere = serviceId ? professionalsForService(professionalsAtHere, serviceId) : professionalsAtHere;
  const pickService = (id: string) => {
    setServiceId(id);
    if (professionalId && !professionalsForService(config.professionals, id).some((p) => p.id === professionalId)) {
      setProfessionalId("");
    }
  };
  const locationHere = chosenLocation(locations, locationId);
  const pickLocation = (id: string) => {
    setLocationId(id);
    const kept = choiceAtLocation({ serviceId, professionalId }, config.services, config.professionals, locations, id);
    setServiceId(kept.serviceId);
    setProfessionalId(kept.professionalId);
  };

  const logo = publicImageSrc(config.tenant.logoUrl);
  const cover = publicImageSrc(config.tenant.coverImageUrl);
  const takesBookings = config.acceptsBookings !== false;
  const salonPhone = config.tenant.phone?.trim() || null;
  const priceLabel = (s: { price: number; currency: string }) =>
    priceOnRequest(s.price) ? "Consultar" : formatPrice(Number(s.price), s.currency || config.tenant.currency);

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-white">
      <div ref={contentRef}>
      {/* The salon's cover photo (Ajustes > Salón) above its name. */}
      {cover && (
        <img
          src={cover}
          alt=""
          width={1200}
          height={300}
          className="block h-28 w-full object-cover sm:h-40"
        />
      )}
      <header className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4 flex items-center gap-3">
        {logo && (
          <img
            src={logo}
            alt=""
            width={40}
            height={40}
            className="w-10 h-10 rounded-full object-cover"
          />
        )}
        <div className="min-w-0">
          <h1 className="font-semibold text-gray-900 break-words">{config.tenant.name}</h1>
          <p className="text-xs text-gray-500">Reserva online</p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-4 sm:p-6">
        {/* No online booking while the salon is read-only: its phone. */}
        {!takesBookings && (
          <div data-test="widget-booking-unavailable" className="text-center space-y-4 py-8">
            <p className="text-gray-700">
              Ahora mismo no se puede reservar online. Llama al salón para pedir cita.
            </p>
            {salonPhone && (
              <a
                href={`tel:${salonPhone.replace(/\s+/g, "")}`}
                target="_top"
                className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-5 py-2.5 font-medium text-white hover:bg-purple-700"
              >
                <Phone className="w-4 h-4" aria-hidden="true" />
                Llamar al {salonPhone}
              </a>
            )}
          </div>
        )}
        {takesBookings && step === "select" && (
          <div className="space-y-6">
            {locations.length > 0 && (
              <div data-test="widget-location-step">
                <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-purple-600" /> Local
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {locations.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      aria-pressed={locationId === l.id}
                      onClick={() => pickLocation(l.id)}
                      className={`text-left p-4 border rounded-lg transition ${
                        locationId === l.id
                          ? "border-purple-500 bg-purple-50"
                          : "border-gray-200 hover:border-purple-300"
                      }`}
                    >
                      <div className="font-medium text-gray-900">{l.name}</div>
                      {l.address && <div className="text-xs text-gray-500 mt-1">{l.address}</div>}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <Scissors className="w-4 h-4 text-purple-600" /> Servicio
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {servicesHere.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={serviceId === s.id}
                    onClick={() => pickService(s.id)}
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
                      <span className="font-semibold text-purple-600">{priceLabel(s)}</span>
                    </div>
                  </button>
                ))}
              </div>
              {config.tenant.taxLabel && (
                <p data-test="widget-tax-included" className="mt-2 text-xs text-gray-500">
                  Precios con {config.tenant.taxLabel} incluido
                </p>
              )}
            </div>

            <div>
              <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <UserIcon className="w-4 h-4 text-purple-600" /> Profesional
              </h2>
              <div className="grid grid-cols-1 min-[360px]:grid-cols-2 md:grid-cols-3 gap-3">
                <button
                  type="button"
                  aria-pressed={!professionalId}
                  onClick={() => setProfessionalId("")}
                  className={`p-3 border rounded-lg text-sm transition ${
                    !professionalId
                      ? "border-purple-500 bg-purple-50"
                      : "border-gray-200 hover:border-purple-300"
                  }`}
                >
                  Cualquiera
                </button>
                {professionalsHere.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={professionalId === p.id}
                    onClick={() => {
                      setProfessionalId(p.id);
                      // No location chosen yet: hers (her main one when she works at several).
                      setLocationId((current) => locationForProfessional(p, locations, current));
                    }}
                    className={`p-3 border rounded-lg text-sm transition break-words ${
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

            {serviceId && !locationReady(locations, locationId) && (
              <p className="text-sm text-gray-500" aria-live="polite">
                Elige el local para ver las horas libres.
              </p>
            )}
            {serviceId && locationReady(locations, locationId) && (
              <div>
                <h2 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-purple-600" aria-hidden="true" />
                  <label htmlFor="widget-date">Fecha y hora</label>
                </h2>
                <input
                  id="widget-date"
                  type="date"
                  aria-label="Fecha"
                  value={date}
                  min={today || undefined}
                  max={lastDay || undefined}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full md:w-1/3 border border-gray-300 rounded-lg px-3 py-2"
                />
                {date && (
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mt-3">
                    {slots.length === 0 && (
                      <div className="col-span-full text-sm text-gray-500" aria-live="polite">
                        {isBeyondWindow(date, lastDay) && lastDay
                          ? `Solo se puede reservar online hasta el ${formatBookingDate(lastDay)}. Elige un día anterior.`
                          : slotsLoading
                            ? "Buscando horas libres…"
                            : "No hay huecos disponibles este día. Prueba con otra fecha u otro profesional."}
                      </div>
                    )}
                    {slots.map((slot) => (
                      <button
                        key={slot.time}
                        type="button"
                        aria-pressed={time === slot.time}
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

        {takesBookings && step === "details" && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 text-sm">
              <strong>{selectedService?.name}</strong> · {time || "--:--"} · {date}
              {locationHere && ` · ${locationHere.name}`}
            </div>
            {!time && (
              <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                Esa hora ya no está libre. Vuelve atrás y elige otra.
              </div>
            )}
            {/* Labelled: a placeholder goes as soon as she types, and a
                screen reader then has no name for the field. */}
            <div>
              <label htmlFor="widget-name" className="block text-sm font-medium text-gray-700 mb-1">
                Nombre y apellidos *
              </label>
              <input
                id="widget-name"
                required
                autoComplete="name"
                placeholder="Nombre y apellidos"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label htmlFor="widget-phone" className="block text-sm font-medium text-gray-700 mb-1">
                Teléfono *
              </label>
              <input
                id="widget-phone"
                required
                type="tel"
                autoComplete="tel"
                placeholder="+34 600 123 456"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label htmlFor="widget-email" className="block text-sm font-medium text-gray-700 mb-1">
                Email (opcional, para recibir la confirmación)
              </label>
              <input
                id="widget-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            <label htmlFor="widget-notes" className="sr-only">
              Notas (opcional)
            </label>
            <textarea
              id="widget-notes"
              placeholder="Notas (opcional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
            />
            {config.whatsappNotices && (
              <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wantsWhatsAppNotices}
                  onChange={(e) => setWantsWhatsAppNotices(e.target.checked)}
                  className="mt-0.5"
                />
                <span>{BOOKING_CHOICE_TEXT.whatsappNotices}</span>
              </label>
            )}
            {config.whatsappPromotions && (
              <div>
                <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wantsWhatsAppPromotions}
                    onChange={(e) => setWantsWhatsAppPromotions(e.target.checked)}
                    aria-describedby="widget-whatsapp-promotions-notice"
                    className="mt-0.5"
                  />
                  <span>{whatsappPromotionsLabel(config.tenant.name)}</span>
                </label>
                <p id="widget-whatsapp-promotions-notice" className="mt-1 ml-6 text-xs text-gray-500">
                  {BOOKING_CHOICE_TEXT.whatsappPromotionsNotice}
                </p>
              </div>
            )}
            <div>
              <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={refusesMarketingEmail}
                  onChange={(e) => setRefusesMarketingEmail(e.target.checked)}
                  aria-describedby="widget-marketing-notice"
                  className="mt-0.5"
                />
                <span>{BOOKING_CHOICE_TEXT.emailRefusal}</span>
              </label>
              <p id="widget-marketing-notice" className="mt-1 ml-6 text-xs text-gray-500">
                {BOOKING_CHOICE_TEXT.emailNotice}
              </p>
            </div>
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
                disabled={submitting || !time}
                className="flex-1 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 disabled:opacity-50"
              >
                {submitting ? "Enviando…" : "Confirmar reserva"}
              </button>
            </div>
            {/* Who uses these details and what for (RGPD art. 13). */}
            <p className="text-xs text-gray-500">
              {config.tenant.name} usará tu nombre, teléfono y email para
              gestionar tu cita y enviarte avisos sobre ella (confirmación,
              recordatorios y cambios) y, si no marcas la casilla de arriba,
              promociones por email.{" "}
              <a
                href={privacyPolicyUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-purple-700"
              >
                Política de privacidad
              </a>
            </p>
          </form>
        )}

        {step === "done" && (
          <div className="text-center space-y-3 py-12">
            <Check className="w-12 h-12 text-green-600 mx-auto" />
            <h2 className="text-xl font-semibold text-gray-900">
              ¡Reserva registrada!
            </h2>
            <p className="text-sm text-gray-500">
              {email.trim()
                ? "Te enviaremos un email de confirmación. Si el salón requiere firma de consentimiento, te llegará un enlace en los próximos minutos."
                : "El salón te contactará en tu teléfono si hay algún cambio."}
            </p>
            {bookedPlace && (
              <p data-test="widget-booked-at" className="text-sm text-gray-700">
                En {bookedPlace.name}
                {bookedPlace.address ? ` · ${bookedPlace.address}` : ""}
              </p>
            )}
            {bookingId && (
              <p className="text-xs text-gray-500">Ref: {bookingId.slice(0, 8)}</p>
            )}
          </div>
        )}
      </main>
      </div>
    </div>
  );
}