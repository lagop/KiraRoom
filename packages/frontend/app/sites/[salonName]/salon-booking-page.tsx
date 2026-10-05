"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Calendar,
  Clock,
  Scissors,
  User,
  ChevronRight,
  MapPin,
  Phone,
  Mail,
  LogIn,
  LogOut,
} from "lucide-react";
import apiClient, { removeToken } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useTenantTranslations } from "@/lib/use-translation";
import {
  formatAddress,
  formatPrice,
  openingHoursRows,
  type PublicSalonPage,
} from "@/lib/salon-seo";
import LoginModal from "./components/login-modal";
import PublicReviewsSection from "./components/public-reviews";
import { ChatWidget } from "@/src/components/virtual-receptionist";

interface BookingData {
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  serviceId: string;
  professionalId: string;
  date: string;
  time: string;
}

interface SalonData {
  id: string;
  name: string;
  description: string;
  address: string;
  phone: string;
  email: string;
  logo: string | null;
  currency: string;
}

interface Professional {
  id: string;
  firstName: string;
  lastName: string;
  specialties: string[];
  /**
   * The services this professional performs, from the ProfessionalService
   * join. GET /professionals has always included it; this interface never
   * declared it, so the booking form matched free-text specialties instead.
   */
  services?: Array<{ serviceId?: string; service?: { id: string } }>;
  profileImage?: string;
  // Portfolio fields
  bio?: string;
  position?: string;
  portfolioImages: string[];
  yearsExperience?: number;
  languages: string[];
  certifications: string[];
}

interface Service {
  id: string;
  name: string;
  description?: string;
  duration: number;
  price: number;
  category: string;
  isActive: boolean;
}

interface AvailableTimeSlot {
  time: string;
  available: boolean;
}

interface UserData {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: string;
}

/**
 * The page's data, shaped for the booking UI. It comes from the server
 * component (page.tsx), so the first HTML already has the salon in it; this
 * component used to start empty and fetch three endpoints after load.
 */
function fromPublicPage(page: PublicSalonPage) {
  const salon: SalonData = {
    id: page.id,
    name: page.name,
    description: page.description ?? "",
    address: formatAddress(page.address),
    phone: page.phone ?? "",
    email: page.email ?? "",
    logo: page.logo,
    currency: page.currency,
  };
  const services: Service[] = page.services.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? undefined,
    duration: s.duration,
    price: s.price,
    category: s.category,
    isActive: true,
  }));
  const professionals: Professional[] = page.professionals.map((p) => ({
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    specialties: p.specialties ?? [],
    services: p.services,
    profileImage: p.profileImage ?? undefined,
    bio: p.bio ?? undefined,
    position: p.position ?? undefined,
    portfolioImages: p.portfolioImages ?? [],
    yearsExperience: p.yearsExperience ?? undefined,
    languages: p.languages ?? [],
    certifications: p.certifications ?? [],
  }));
  return { salon, services, professionals };
}

const DEPOSIT_CHECKOUT_KEY = "kira-deposit-checkout";

export default function SalonBookingPage({
  salonName,
  initialData,
}: {
  salonName: string;
  initialData: PublicSalonPage;
}) {
  const { toast } = useToast();
  const { t, language, setLanguage } = useTenantTranslations();
  const [loading, setLoading] = useState(false);
  const [initial] = useState(() => fromPublicPage(initialData));
  const salonData: SalonData = initial.salon;
  const professionals = initial.professionals;
  const services = initial.services;
  const hoursRows = openingHoursRows(initialData.openingHours);
  const [availableSlots, setAvailableSlots] = useState<AvailableTimeSlot[]>([]);
  const [bookingData, setBookingData] = useState<BookingData>({
    clientName: "",
    clientEmail: "",
    clientPhone: "",
    serviceId: "",
    professionalId: "",
    date: "",
    time: "",
  });
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserData | null>(null);

  // Check if user is already logged in on component mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const userStr = localStorage.getItem("user");
      if (userStr) {
        const user = JSON.parse(userStr);
        setCurrentUser(user);
        // Auto-fill booking data with user information
        setBookingData((prev) => ({
          ...prev,
          clientName: `${user.firstName} ${user.lastName}`,
          clientEmail: user.email,
          clientPhone: user.phone || "",
        }));
      }
    }
  }, []);

  // Links from a wait-list notice (and rebooking reminders) carry the
  // service, professional and day of the freed slot: start the form there.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    const serviceId = q.get("serviceId") || "";
    const professionalId = q.get("professionalId") || "";
    const date = /^d{4}-d{2}-d{2}$/.test(q.get("date") || "") ? (q.get("date") as string) : "";
    if (serviceId || professionalId || date) {
      setBookingData((prev) => ({
        ...prev,
        serviceId: serviceId || prev.serviceId,
        professionalId: professionalId || prev.professionalId,
        date: date || prev.date,
      }));
    }
  }, []);

  const handleLoginSuccess = (user: UserData) => {
    setCurrentUser(user);
    // Auto-fill booking data with user information
    setBookingData((prev) => ({
      ...prev,
      clientName: `${user.firstName} ${user.lastName}`,
      clientEmail: user.email,
      clientPhone: user.phone || "",
    }));
  };

  const handleLogout = async () => {
    try {
      await apiClient.logout();
    } catch (error) {
      // Ignore logout errors (e.g., if token is already invalid)
    }
    removeToken();
    if (typeof window !== "undefined") {
      localStorage.removeItem("user");
    }
    setCurrentUser(null);
    // Reset booking data
    setBookingData((prev) => ({
      ...prev,
      clientName: "",
      clientEmail: "",
      clientPhone: "",
    }));
    toast({
      title: "Logged out",
      description: "You have been successfully logged out.",
    });
  };

  // Back from paying (or not) the deposit on Stripe.
  useEffect(() => {
    const deposit = new URLSearchParams(window.location.search).get("deposit");
    if (deposit === "paid") {
      toast({
        title: "Reserva confirmada",
        description: "Hemos recibido la señal. Tu cita queda confirmada.",
      });
    } else if (deposit === "cancelled") {
      // The Stripe page stays valid until the hold runs out.
      let pending: { checkoutUrl: string; expiresAt: string } | null = null;
      try {
        pending = JSON.parse(sessionStorage.getItem(DEPOSIT_CHECKOUT_KEY) || "null");
      } catch {}
      const payable = pending && new Date(pending.expiresAt).getTime() > Date.now();
      toast({
        title: "Reserva sin confirmar",
        description: payable
          ? "Falta pagar la señal. Te guardamos el hueco hasta entonces; si no la pagas, se libera en unos minutos."
          : "No se ha pagado la señal, así que la cita no está confirmada.",
        variant: "destructive",
        duration: payable ? 60_000 : undefined,
        action: payable ? (
          <ToastAction altText="Pagar la señal" onClick={() => (window.location.href = pending!.checkoutUrl)}>
            Pagar la señal
          </ToastAction>
        ) : undefined,
      });
    }
    if (deposit === "paid") {
      try {
        sessionStorage.removeItem(DEPOSIT_CHECKOUT_KEY);
      } catch {}
    }
    if (deposit) window.history.replaceState(null, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Set default date to today + 1 day
  useEffect(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setBookingData((prev) => ({
      ...prev,
      // A date from the link (see above) wins.
      date: prev.date || tomorrow.toISOString().split("T")[0],
    }));
  }, []);

  // Fetch available time slots
  useEffect(() => {
    const fetchAvailableSlots = async () => {
      // Only fetch slots if service and professional are selected
      if (!bookingData.professionalId || !bookingData.serviceId) {
        setAvailableSlots([]);
        return;
      }

      if (!salonData?.id || !bookingData.date) {
        setAvailableSlots([]);
        return;
      }

      try {
        // These were invented: every half hour from 09:00 to 19:30, all
        // flagged available "for demo purposes". It ignored the professional's
        // shift and every appointment already booked, so a client could take
        // 19:30 on a day the salon shuts at 18:00, or a slot someone else
        // already had.
        //
        // GET /appointments/available-slots is @Public() and has always
        // existed. It checks overlaps against real appointments, uses the
        // service's real duration, and now respects the professional's
        // working hours too.
        const slots = await apiClient.getAvailableSlots(
          salonData.id,
          bookingData.professionalId,
          bookingData.serviceId,
          bookingData.date,
        );

        setAvailableSlots(
          slots.map((slot) => ({
            time: slot.time,
            available: slot.isAvailable,
          })),
        );
      } catch (error) {
        console.error("Error fetching available slots:", error);
        toast({
          title: "Error",
          description: "No se pudo cargar los horarios disponibles",
          variant: "destructive",
        });
      }
    };

    // Debounce fetching slots
    const timer = setTimeout(() => {
      fetchAvailableSlots();
    }, 500);

    return () => clearTimeout(timer);
    // The date belongs here: with invented slots it made no difference, so
    // picking another day never refetched anything.
  }, [
    bookingData.professionalId,
    bookingData.serviceId,
    bookingData.date,
    salonData?.id,
  ]);

  const handleInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
  ) => {
    const { name, value } = e.target;

    // Always clear time slots when changing service or professional
    if (name === "serviceId" || name === "professionalId") {
      setAvailableSlots([]);

      setBookingData((prev) => ({
        ...prev,
        [name]: value,
        professionalId: name === "serviceId" ? "" : prev.professionalId, // Clear professional when service changes
        time: "", // Clear selected time as well
      }));
    } else {
      setBookingData((prev) => ({
        ...prev,
        [name]: value,
      }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // This used to be a stub. It logged the payload to the browser
      // console, waited 1500 ms so the button looked busy, and then said
      // "Reserva confirmada" — with no request to the backend at all. A
      // client left believing she had an appointment, the salon never saw
      // one, and nobody found out until she turned up at the door.
      //
      // POST /appointments has always been @Public(), and the service finds
      // or creates the client from clientInfo. Only the call was missing.
      if (!salonData?.id) {
        throw new Error("Salon not loaded");
      }

      const [firstName, ...restOfName] = bookingData.clientName.trim().split(" ");

      const booking = await apiClient.createAppointment({
        tenantId: salonData.id,
        // Back here from Stripe when the service asks for a deposit.
        returnPath: `/sites/${salonName}`,
        // Signed in or not, the booking carries the client's details: the
        // public endpoint takes no clientId (an anonymous caller must not
        // book as someone else) and finds the client by email or phone in
        // this salon. Sending only clientId made every signed-in booking fail
        // with "clientInfo should not be null or undefined".
        clientInfo: currentUser
          ? {
              firstName: currentUser.firstName,
              lastName: currentUser.lastName ?? "",
              email: currentUser.email || undefined,
              phone: currentUser.phone || bookingData.clientPhone,
            }
          : {
              firstName,
              lastName: restOfName.join(" "),
              email: bookingData.clientEmail.trim() || undefined,
              phone: bookingData.clientPhone,
            },
        serviceId: bookingData.serviceId,
        professionalId: bookingData.professionalId,
        // The DTO's names, not the form's: it wants scheduledDate and
        // scheduledTime. The stub spread `bookingData` as-is, so even if it
        // had posted, the fields would not have matched.
        scheduledDate: bookingData.date,
        scheduledTime: bookingData.time,
      });

      // The service asks for a deposit: the slot is held while the client
      // pays on Stripe, which sends them back here with ?deposit=...
      if (booking.deposit?.checkoutUrl) {
        try {
          // To offer the payment again if the client backs out of Stripe.
          sessionStorage.setItem(DEPOSIT_CHECKOUT_KEY, JSON.stringify(booking.deposit));
        } catch {}
        window.location.href = booking.deposit.checkoutUrl;
        return;
      }

      // Only now. The confirmation has to mean the appointment exists.
      toast({
        title: t("bookingPublic.booking_confirmed"),
        description: t("bookingPublic.booking_confirmed"),
      });

      // Reset form
      setBookingData({
        clientName: currentUser
          ? `${currentUser.firstName} ${currentUser.lastName}`
          : "",
        clientEmail: currentUser ? currentUser.email : "",
        clientPhone: currentUser ? currentUser.phone || "" : "",
        serviceId: "",
        professionalId: "",
        date: "",
        time: "",
      });

      // Set default date to tomorrow again
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      setBookingData((prev) => ({
        ...prev,
        date: tomorrow.toISOString().split("T")[0],
      }));
    } catch (error) {
      console.error("Error booking appointment:", error);
      // Pass the server's reason through. The slot may have been taken while
      // this form sat open, and "try again" tells the client nothing about
      // whether trying again would help.
      toast({
        title: "Error",
        description:
          error instanceof Error && error.message
            ? error.message
            : "No se pudo reservar la cita. Por favor, intenta nuevamente.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    if (!dateString) return "";

    const date = new Date(dateString);
    const options: Intl.DateTimeFormatOptions = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    };

    return date.toLocaleDateString("es-ES", options);
  };

  // Filter professionals based on selected service
  // Which professionals can perform the chosen service.
  //
  // This compared each professional's free-text `specialties` against the
  // service's name and category. A professional created by the onboarding
  // wizard has `specialties: []`, and `[].some()` is false, so nobody
  // matched, no professional could be picked and no booking was possible.
  // Every salon that completed onboarding had an unbookable public page.
  //
  // The database had the answer all along, in ProfessionalService.
  const linkedProfessionals = bookingData.serviceId
    ? professionals.filter((pro) =>
        (pro.services ?? []).some(
          (link) =>
            (link.service?.id ?? link.serviceId) === bookingData.serviceId,
        ),
      )
    : [];

  // Nothing linked to this service: offer everyone rather than nobody. An
  // unbookable page is the worse failure, and it is the one this block exists
  // to stop happening again.
  const filteredProfessionals =
    bookingData.serviceId && linkedProfessionals.length === 0
      ? professionals
      : linkedProfessionals;

  // Filter available dates based on salon settings
  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedDate = new Date(e.target.value);
    const dayOfWeek = selectedDate.getDay();

    // Salon is open Monday-Saturday (1-6)
    if (dayOfWeek === 0) {
      // Sunday
      toast({
        title: t("bookingPublic.dateUnavailable"),
        description: t("bookingPublic.salonClosedSunday"),
        variant: "destructive",
      });
      setAvailableSlots([]);
      return;
    }

    setBookingData((prev) => ({
      ...prev,
      date: e.target.value,
    }));
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-pink-50">
      {/* Navbar */}
      <nav className="bg-white shadow-sm border-b border-gray-200 sticky top-0 z-40">
        <div className="container mx-auto px-4">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center space-x-3">
              {salonData?.logo && (
                <div className="w-8 h-8 bg-purple-100 rounded-full flex items-center justify-center">
                  <img
                    src={salonData.logo}
                    alt={`${salonData.name} Logo`}
                    className="w-6 h-6 rounded-full object-cover"
                  />
                </div>
              )}
              <span className="font-semibold text-gray-900">
                {salonData?.name}
              </span>
            </div>

            {/* Login/Logout Section */}
            <div className="flex items-center space-x-4">
              {currentUser ? (
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white font-semibold text-sm">
                      {currentUser.firstName.charAt(0)}
                      {currentUser.lastName.charAt(0)}
                    </div>
                    <div className="text-left hidden md:block">
                      <p className="text-sm font-medium text-gray-900">
                        {currentUser.firstName} {currentUser.lastName}
                      </p>
                      <p className="text-xs text-gray-500">
                        {currentUser.email}
                      </p>
                    </div>
                  </div>
                  <Link
                    href={`/sites/${salonName}/account`}
                    className="flex items-center space-x-2 bg-purple-100 text-purple-700 px-3 py-1.5 rounded-lg hover:bg-purple-200 transition-colors text-sm"
                  >
                    <User className="w-4 h-4" />
                    <span>{t("nav.dashboard")}</span>
                  </Link>
                  <button
                    onClick={handleLogout}
                    className="flex items-center space-x-2 bg-purple-600 text-white px-3 py-1.5 rounded-lg hover:bg-purple-700 transition-colors text-sm"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>{t("nav.logout")}</span>
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setIsLoginModalOpen(true)}
                  className="flex items-center space-x-2 bg-purple-600 text-white px-3 py-1.5 rounded-lg hover:bg-purple-700 transition-colors text-sm"
                >
                  <LogIn className="w-4 h-4" />
                  <span>{t("login.login")}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </nav>

      <div className="container mx-auto px-4 py-12">
        {/* Salon Header */}
        <div className="text-center mb-12">
          {salonData?.logo && (
            <div className="mx-auto w-24 h-24 bg-purple-100 rounded-full flex items-center justify-center mb-4">
              <img
                src={salonData.logo}
                alt={`${salonData.name} Logo`}
                className="w-16 h-16 rounded-full object-cover"
              />
            </div>
          )}
          <h1 className="text-4xl font-bold text-purple-900 mb-2">
            {salonData?.name}
          </h1>
          {salonData.description && (
            <p className="text-gray-600 mb-6 max-w-2xl mx-auto whitespace-pre-line">
              {salonData.description}
            </p>
          )}
          {/* Only what the salon filled in: empty icons read as broken. */}
          <address className="not-italic flex flex-wrap justify-center items-center gap-x-6 gap-y-2 text-sm text-gray-500">
            {salonData.address && (
              <span className="flex items-center space-x-1">
                <MapPin className="w-4 h-4 text-purple-600" />
                <span>{salonData.address}</span>
              </span>
            )}
            {salonData.phone && (
              <a href={`tel:${salonData.phone.replace(/\s+/g, "")}`} className="flex items-center space-x-1 hover:text-purple-700">
                <Phone className="w-4 h-4 text-purple-600" />
                <span>{salonData.phone}</span>
              </a>
            )}
            {salonData.email && (
              <a href={`mailto:${salonData.email}`} className="flex items-center space-x-1 hover:text-purple-700">
                <Mail className="w-4 h-4 text-purple-600" />
                <span>{salonData.email}</span>
              </a>
            )}
          </address>
        </div>

        {/* Booking Form */}
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-2xl shadow-lg p-8">
            <h2 className="text-2xl font-bold text-purple-900 mb-6 text-center">
              {t("bookingPublic.title")}
            </h2>

            <form onSubmit={handleSubmit} className="space-y-8">
              {/* Step 1: Client Information */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                  <User className="w-5 h-5 mr-2 text-purple-600" />
                  {t("bookingPublic.step_4")}
                </h3>

                {currentUser ? (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                    <p className="text-green-800 mb-2">
                      <strong>{t("bookingPublic.personal_info")}</strong>
                    </p>
                    <p className="text-sm text-green-700 mb-1">
                        <strong>{t("common.name")}:</strong> {currentUser.firstName}{" "}
                        {currentUser.lastName}
                      </p>
                      <p className="text-sm text-green-700 mb-1">
                        <strong>{t("common.email")}:</strong> {currentUser.email}
                      </p>
                      {currentUser.phone ? (
                        <p className="text-sm text-green-700">
                          <strong>{t("common.phone")}:</strong> {currentUser.phone}
                        </p>
                      ) : (
                        // Online bookings need a phone: it is how the salon
                        // reaches the client about a last-minute change.
                        <div className="mt-3">
                          <label
                            htmlFor="clientPhone"
                            className="block text-sm font-medium text-gray-700 mb-1"
                          >
                            {t("bookingPublic.phone")} *
                          </label>
                          <input
                            type="tel"
                            id="clientPhone"
                            name="clientPhone"
                            value={bookingData.clientPhone}
                            onChange={handleInputChange}
                            required
                            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                            placeholder="+34 123 456 789"
                          />
                        </div>
                      )}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label
                        htmlFor="clientName"
                        className="block text-sm font-medium text-gray-700 mb-1"
                      >
                        {t("bookingPublic.first_name")} {t("bookingPublic.last_name")} *
                      </label>
                      <input
                        type="text"
                        id="clientName"
                        name="clientName"
                        value={bookingData.clientName}
                        onChange={handleInputChange}
                        required
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                        placeholder="John Doe"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="clientEmail"
                        className="block text-sm font-medium text-gray-700 mb-1"
                      >
                        {t("bookingPublic.email")} ({t("common.optional").toLowerCase()})
                      </label>
                      {/* Optional: the phone is how the salon reaches the
                          client about a change; the email only brings the
                          confirmation. */}
                      <input
                        type="email"
                        id="clientEmail"
                        name="clientEmail"
                        value={bookingData.clientEmail}
                        onChange={handleInputChange}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                        placeholder="john@example.com"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="clientPhone"
                        className="block text-sm font-medium text-gray-700 mb-1"
                      >
                        {t("bookingPublic.phone")} *
                      </label>
                      <input
                        type="tel"
                        id="clientPhone"
                        name="clientPhone"
                        value={bookingData.clientPhone}
                        onChange={handleInputChange}
                        required
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                        placeholder="+34 123 456 789"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Step 2: Service Selection */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                  <Scissors className="w-5 h-5 mr-2 text-purple-600" />
                  {t("bookingPublic.step_1")}
                </h3>

                <select
                  id="serviceId"
                  name="serviceId"
                  value={bookingData.serviceId}
                  onChange={handleInputChange}
                  required
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                >
                  <option value="">-- {t("bookingPublic.select_service")} --</option>
                  {services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name} - {formatPrice(service.price, salonData.currency)} ({service.duration} min)
                    </option>
                  ))}
                </select>
              </div>

              {/* Step 3: Professional Selection */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                  <User className="w-5 h-5 mr-2 text-purple-600" />
                  {t("bookingPublic.step_2")}
                </h3>

                {bookingData.serviceId ? (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {filteredProfessionals.map((professional) => (
                      <button
                        key={professional.id}
                        type="button"
                        onClick={() =>
                          setBookingData((prev) => ({
                            ...prev,
                            professionalId: professional.id,
                          }))
                        }
                        className={`p-4 border rounded-lg transition-colors text-left ${
                          bookingData.professionalId === professional.id
                            ? "border-purple-500 bg-purple-50"
                            : "border-gray-200 hover:border-purple-300"
                        }`}
                      >
                        <div className="flex items-center space-x-3">
                          <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center">
                            {professional.profileImage ? (
                              <img
                                src={professional.profileImage}
                                alt={professional.firstName}
                                className="w-12 h-12 rounded-full object-cover"
                              />
                            ) : (
                              <User className="w-6 h-6 text-purple-600" />
                            )}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900">
                              {professional.firstName} {professional.lastName}
                            </p>
                            <p className="text-sm text-gray-500">
                              {professional.specialties.slice(0, 2).join(", ")}
                              {professional.specialties.length > 2 && "..."}
                            </p>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="p-6 text-center text-gray-500 bg-gray-50 rounded-lg">
                    {t("bookingPublic.select_service_first")}
                  </div>
                )}
              </div>

              {/* Step 4: Date Selection */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                  <Calendar className="w-5 h-5 mr-2 text-purple-600" />
                  {t("bookingPublic.step_3")}
                </h3>

                <input
                  type="date"
                  id="date"
                  name="date"
                  value={bookingData.date}
                  onChange={handleDateChange}
                  required
                  min={new Date().toISOString().split("T")[0]}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                />

                {bookingData.date && (
                  <p className="text-sm text-gray-500">
                    {formatDate(bookingData.date)}
                  </p>
                )}
              </div>

              {/* Step 5: Time Selection */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                  <Clock className="w-5 h-5 mr-2 text-purple-600" />
                  {t("bookingPublic.select_time")}
                </h3>

                {bookingData.professionalId &&
                bookingData.serviceId &&
                availableSlots.length > 0 ? (
                  <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    {availableSlots.map((slot, index) => (
                      <button
                        key={index}
                        type="button"
                        onClick={() =>
                          setBookingData((prev) => ({
                            ...prev,
                            time: slot.time,
                          }))
                        }
                        disabled={!slot.available}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          bookingData.time === slot.time
                            ? "bg-purple-600 text-white"
                            : slot.available
                              ? "bg-purple-50 text-purple-600 hover:bg-purple-100"
                              : "bg-gray-100 text-gray-400 cursor-not-allowed"
                        }`}
                      >
                        {slot.time}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-gray-500">
                    {t("bookingPublic.select_service_first")}
                  </div>
                )}
              </div>

              {/* Submit Button */}
              <div className="pt-4">
                <button
                  type="submit"
                  disabled={loading || !bookingData.time}
                  className="w-full px-6 py-3 bg-purple-600 text-white font-medium rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2"
                >
                  {loading ? (
                    <>
                      <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                      <span>{t("common.loading")}</span>
                    </>
                  ) : (
                    <>
                      <span>{t("bookingPublic.confirm_booking")}</span>
                      <ChevronRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>

          {/* Salon Information Section. Every service with its price and
              every professional are in the HTML (no "show more" that only
              renders on click): this is what a search engine reads. */}
          <section className="mt-8 bg-white rounded-2xl shadow-lg p-8">
            <h2 className="text-xl font-bold text-purple-900 mb-4">
              {t("sites.about", { name: salonData.name })}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">
                  {t("sites.ourServices")}
                </h3>
                <ul className="space-y-2 text-gray-600">
                  {services.map((service) => (
                    <li key={service.id} className="flex items-start justify-between gap-4">
                      <span className="flex items-start space-x-2">
                        <span className="mt-2 w-2 h-2 shrink-0 bg-purple-500 rounded-full" />
                        <span>
                          <span className="text-gray-800">{service.name}</span>
                          {service.description && (
                            <span className="block text-xs text-gray-500">{service.description}</span>
                          )}
                        </span>
                      </span>
                      <span className="whitespace-nowrap text-sm">
                        {formatPrice(service.price, salonData.currency)}
                        <span className="text-gray-400"> · {service.duration} min</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-6">
                {hoursRows.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2 flex items-center">
                      <Clock className="w-4 h-4 mr-2 text-purple-600" />
                      Horario
                    </h3>
                    <table className="text-sm text-gray-600">
                      <tbody>
                        {hoursRows.map((row) => (
                          <tr key={row.day}>
                            <td className="pr-6 py-0.5">{row.day}</td>
                            <td className="py-0.5">{row.hours ?? "Cerrado"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {professionals.length > 0 && (
                  <div>
                    <h3 className="font-semibold text-gray-900 mb-2">
                      {t("sites.ourProfessionals")}
                    </h3>
                    <ul className="space-y-2 text-gray-600">
                      {professionals.map((professional) => (
                        <li key={professional.id} className="flex items-center space-x-2">
                          <span className="w-2 h-2 bg-purple-500 rounded-full" />
                          <span>
                            {professional.firstName} {professional.lastName}
                            {professional.position && (
                              <span className="text-gray-400"> · {professional.position}</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Professional Team Section */}
          {professionals.length > 0 && (
            <div className="mt-8">
              <h3 className="text-2xl font-bold text-purple-900 mb-6 text-center">
                {t("sites.ourTeam")}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {professionals.slice(0, 6).map((professional) => (
                  <div
                    key={professional.id}
                    className="bg-white rounded-xl shadow-md overflow-hidden hover:shadow-lg transition-shadow"
                  >
                    {/* Profile Image */}
                    <div className="h-32 bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                      {professional.profileImage ? (
                        <img
                          src={professional.profileImage}
                          alt={`${professional.firstName} ${professional.lastName}`}
                          className="w-24 h-24 rounded-full object-cover border-4 border-white"
                        />
                      ) : (
                        <span className="text-4xl text-white font-bold">
                          {professional.firstName[0]}
                          {professional.lastName[0]}
                        </span>
                      )}
                    </div>
                    {/* Professional Info */}
                    <div className="p-4">
                      <h4 className="font-bold text-gray-900 text-lg">
                        {professional.firstName} {professional.lastName}
                      </h4>
                      {professional.position && (
                        <p className="text-purple-600 text-sm font-medium">
                          {professional.position}
                        </p>
                      )}
                      {professional.bio && (
                        <p className="text-gray-600 text-sm mt-2 line-clamp-2">
                          {professional.bio}
                        </p>
                      )}
                      {/* Portfolio Info */}
                      <div className="mt-3 space-y-1">
                        {professional.yearsExperience && (
                          <p className="text-xs text-gray-500">
                            <span className="font-medium">
                              {professional.yearsExperience}
                            </span>{" "}
                            {t("sites.yearsExperience")}
                          </p>
                        )}
                        {professional.languages &&
                          professional.languages.length > 0 && (
                            <p className="text-xs text-gray-500">
                              <span className="font-medium">{t("sites.languages")}</span>{" "}
                              {professional.languages.join(", ")}
                            </p>
                          )}
                        {professional.certifications &&
                          professional.certifications.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {professional.certifications
                                .slice(0, 2)
                                .map((cert, idx) => (
                                  <span
                                    key={idx}
                                    className="px-2 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full"
                                  >
                                    {cert}
                                  </span>
                                ))}
                              {professional.certifications.length > 2 && (
                                <span className="text-xs text-gray-500">
                                  +{professional.certifications.length - 2}
                                </span>
                              )}
                            </div>
                          )}
                      </div>
                      {/* Portfolio Images Preview */}
                      {professional.portfolioImages &&
                        professional.portfolioImages.length > 0 && (
                          <div className="mt-3 flex gap-1">
                            {professional.portfolioImages
                              .slice(0, 3)
                              .map((img, idx) => (
                                <img
                                  key={idx}
                                  src={img}
                                  alt={t("sites.portfolioWork", { n: idx + 1 })}
                                  className="w-12 h-12 object-cover rounded-lg"
                                />
                              ))}
                            {professional.portfolioImages.length > 3 && (
                              <div className="w-12 h-12 bg-gray-100 rounded-lg flex items-center justify-center text-xs text-gray-500">
                                +{professional.portfolioImages.length - 3}
                              </div>
                            )}
                          </div>
                        )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {salonData?.id && <PublicReviewsSection tenantId={salonData.id} />}
        </div>
      </div>

      {/* Language Selector Footer */}
      <footer className="bg-white border-t border-gray-200 py-6 mt-12">
        <div className="container mx-auto px-4">
          <div className="flex justify-center items-center">
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-500">
                {t("settings.language")}:
              </span>
              <button
                onClick={() => {
                  setLanguage("es");
                  localStorage.setItem("kira_language", "es");
                }}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  language === "es"
                    ? "bg-purple-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {t("common.spanish")}
              </button>
              <button
                onClick={() => {
                  setLanguage("en");
                  localStorage.setItem("kira_language", "en");
                }}
                className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                  language === "en"
                    ? "bg-purple-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {t("common.english")}
              </button>
            </div>
          </div>
        </div>
      </footer>

      {/* Login Modal */}
      <LoginModal
        isOpen={isLoginModalOpen}
        onClose={() => setIsLoginModalOpen(false)}
        onLoginSuccess={handleLoginSuccess}
      />

      {/* Virtual Receptionist Widget */}
      {salonData && (
        <ChatWidget
          salonId={salonData.id}
          clientId={currentUser?.id}
          clientName={
            currentUser
              ? `${currentUser.firstName} ${currentUser.lastName}`
              : undefined
          }
          clientEmail={currentUser?.email}
          clientPhone={currentUser?.phone}
        />
      )}
    </div>
  );
}


