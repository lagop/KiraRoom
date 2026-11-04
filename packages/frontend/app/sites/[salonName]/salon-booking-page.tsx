"use client";

import { useState, useEffect, useRef } from "react";
import {
  Calendar,
  Clock,
  Scissors,
  User,
  ChevronRight,
  MapPin,
  Phone,
  Mail,
  Instagram,
  Facebook,
  CheckCircle,
} from "lucide-react";
import apiClient from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { useTenantTranslations } from "@/lib/use-translation";
import {
  acceptsBookings,
  formatAddress,
  formatPrice,
  openingHoursRows,
  priceOnRequest,
  publicImageSrc,
  socialLinks,
  type PublicSalonPage,
  type SocialLink,
} from "@/lib/salon-seo";
import type { PublicReviews } from "@/lib/public-site-server";
import {
  bookingDateFromQuery,
  bookingErrorMessage,
  formatBookingDate,
  isBeyondWindow,
  isClosedDay,
  isOfferedTime,
  localDateString,
  localTomorrow,
  privacyPolicyUrl,
  slotsState,
  splitClientName,
  BOOKING_CHOICE_TEXT,
  whatsappPromotionsLabel,
} from "@/lib/public-booking";
import { professionalAfterServiceChange, servicesForPinned } from "@/lib/booking-professional";
import {
  bookingLocations,
  choiceAtLocation,
  chosenLocation,
  closedDaysAt,
  confirmedPlace,
  locationForProfessional,
  locationFromQuery,
  locationReady,
  professionalsAtLocation,
  professionalsForService,
  servicesAtLocation,
} from "@/lib/public-booking-locations";
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
  /** One of the salon's locations, when it has several (empty otherwise). */
  locationId: string;
}

interface SalonData {
  id: string;
  name: string;
  description: string;
  address: string;
  phone: string;
  email: string;
  /** Where to load them from (publicImageSrc), never a data: URL. */
  logo: string | null;
  cover: string | null;
  currency: string;
  /** Instagram and Facebook, from the salon's general settings. */
  social: SocialLink[];
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
  /** Where they work, when the salon has locations to pick from. */
  locationIds?: string[];
  primaryLocationId?: string | null;
}

interface Service {
  id: string;
  name: string;
  description?: string;
  duration: number;
  price: number;
  category: string;
  isActive: boolean;
  isOnlineBookable: boolean;
}

interface AvailableTimeSlot {
  time: string;
  available: boolean;
}

/**
 * What the page shows once the server has the booking: it used to be a toast
 * that vanished while the form went blank, so on a phone she could not tell
 * whether she had booked and tried again.
 */
interface BookedSummary {
  /** The appointment's status in the answer: "confirmed", or waiting for the salon. */
  confirmed: boolean;
  serviceName: string;
  professionalName: string;
  date: string;
  time: string;
  /** Where: the location (multi-local) or the salon's own address. */
  place: { name: string; address: string } | null;
  email: string;
  ref: string;
}

/** A per-visitor convenience: a strict private window throws on localStorage. */
function rememberLanguage(language: string): void {
  try {
    localStorage.setItem("kira_language", language);
  } catch {
    // Not remembered; the page still switches.
  }
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
    logo: publicImageSrc(page.logoUrl),
    cover: publicImageSrc(page.coverImageUrl),
    currency: page.currency,
    social: socialLinks(page),
  };
  const services: Service[] = page.services.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? undefined,
    duration: s.duration,
    price: s.price,
    category: s.category,
    isActive: true,
    isOnlineBookable: s.isOnlineBookable !== false,
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
    locationIds: p.locationIds,
    primaryLocationId: p.primaryLocationId ?? null,
  }));
  return { salon, services, professionals };
}

export default function SalonBookingPage({
  salonName,
  initialData,
  initialReviews,
}: {
  salonName: string;
  initialData: PublicSalonPage;
  /** Fetched with the page on the server; undefined when that failed. */
  initialReviews?: PublicReviews;
}) {
  const { toast } = useToast();
  const { t, language, setLanguage } = useTenantTranslations();
  const [loading, setLoading] = useState(false);
  const [initial] = useState(() => fromPublicPage(initialData));
  const salonData: SalonData = initial.salon;
  const professionals = initial.professionals;
  const services = initial.services;
  // Two or more locations to book at: the client picks one (or it follows
  // from the professional). None for a salon with one location: no step.
  const [locations] = useState(() => bookingLocations(initialData));
  // The booking form offers only what the salon takes online; the price list shows everything.
  const bookableServices = services.filter((s) => s.isOnlineBookable);
  // The prices are final (the server adds the tax to a catalogue written
  // without it); said once per list: "Precios con IVA incluido".
  const taxIncluded = initialData.taxLabel ? t("sites.taxIncluded", { label: initialData.taxLabel }) : null;
  const hoursRows = openingHoursRows(initialData.openingHours, initialData.openingShifts);
  // A read-only salon (trial ended, cancelled, suspended): its details and
  // phone, no form, which would be refused at the very end.
  const takesBookings = acceptsBookings(initialData);
  const phoneHref = salonData.phone ? `tel:${salonData.phone.replace(/\s+/g, "")}` : null;
  const [availableSlots, setAvailableSlots] = useState<AvailableTimeSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  // Bumped to ask the server for the slots again (after a failed booking).
  const [slotsRefresh, setSlotsRefresh] = useState(0);
  // The visitor's own calendar day, set after mount: the server renders in
  // UTC and this page is cached for minutes, so a server-side "today" could
  // be the wrong day.
  const [today, setToday] = useState("");
  const [bookingData, setBookingData] = useState<BookingData>({
    clientName: "",
    clientEmail: "",
    clientPhone: "",
    serviceId: "",
    professionalId: "",
    date: "",
    time: "",
    locationId: "",
  });
  // The two boxes next to the button, both unticked (BOOKING_CHOICE_TEXT).
  const [refusesMarketingEmail, setRefusesMarketingEmail] = useState(false);
  const [wantsWhatsAppNotices, setWantsWhatsAppNotices] = useState(false);
  // Only when the salon has its WhatsApp number connected.
  const offersWhatsAppNotices = initialData.whatsappNotices === true;
  // Optional, never pre-ticked: only when the salon has WhatsApp connected
  // and its plan includes WhatsApp campaigns. Unticked sends nothing.
  const [wantsWhatsAppPromotions, setWantsWhatsAppPromotions] = useState(false);
  const offersWhatsAppPromotions = initialData.whatsappPromotions === true;
  // The professional a QR code or link chose (?professionalId=), until the
  // client asks to see the whole team.
  const [pinnedProfessionalId, setPinnedProfessionalId] = useState("");
  // The booking just made: the form gives way to its summary (R9).
  const [confirmation, setConfirmation] = useState<BookedSummary | null>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  // The last day the chosen service can be booked online, from the server.
  const [bookingWindow, setBookingWindow] = useState<{ serviceId: string; lastDay: string } | null>(null);
  const pinnedProfessional = professionals.find((p) => p.id === pinnedProfessionalId);
  // Links from a wait-list notice (and rebooking reminders) carry the
  // service, professional and day of the freed slot: start the form there.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search);
    // ?service= is what rebooking emails and the old client area sent.
    const serviceId = q.get("serviceId") || q.get("service") || "";
    const professionalId = q.get("professionalId") || "";
    // The pattern was written without backslashes (/^d{4}-d{2}-d{2}$/), so
    // it matched "dddd-dd-dd" and never a date: every link lost its day.
    const date = bookingDateFromQuery(q.get("date"));
    // ?locationId=<id> or ?location=<slug>: a link to one of the salon's
    // locations; else the professional's from the link, if any.
    const linked = locationFromQuery(q, locations);
    const locationId =
      linked || locationForProfessional(professionals.find((p) => p.id === professionalId), locations, "");
    if (serviceId || professionalId || date || locationId) {
      setBookingData((prev) => ({
        ...prev,
        serviceId: serviceId || prev.serviceId,
        professionalId: professionalId || prev.professionalId,
        date: date || prev.date,
        locationId: locationId || prev.locationId,
      }));
    }
    // A professional's QR code (or link): she stays chosen, and the form
    // offers the services she does (lib/booking-professional.ts).
    if (professionalId && professionals.some((p) => p.id === professionalId)) {
      setPinnedProfessionalId(professionalId);
    }
    // Read once, from the page's own data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default date: tomorrow, in the visitor's calendar. toISOString() gave
  // the UTC day, which after midnight in Spain was still today.
  useEffect(() => {
    setToday(localDateString());
    setBookingData((prev) => ({
      ...prev,
      // A date from the link (see above) wins.
      date: prev.date || localTomorrow(),
    }));
  }, []);

  // How far ahead the chosen service can be booked: the date picker stops
  // there, and a later day says why it has no times. Without an answer
  // (older server) nothing changes.
  useEffect(() => {
    const serviceId = bookingData.serviceId;
    if (!serviceId || !salonData?.id) return;
    let cancelled = false;
    apiClient
      .getBookingWindow(salonData.id, serviceId)
      .then((w) => {
        if (!cancelled && w?.lastDay) setBookingWindow({ serviceId, lastDay: w.lastDay });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bookingData.serviceId, salonData?.id]);
  const lastDay = bookingWindow && bookingWindow.serviceId === bookingData.serviceId ? bookingWindow.lastDay : null;

  // The summary takes the focus, so a screen reader reads it and a phone
  // scrolls to it.
  useEffect(() => {
    if (confirmation) doneRef.current?.focus();
  }, [confirmation]);

  // Fetch available time slots
  useEffect(() => {
    // The list on screen belongs to the previous service, professional or
    // day: drop it now, so nothing from it can be picked or sent while the
    // new one loads.
    setAvailableSlots([]);
    let cancelled = false;

    const fetchAvailableSlots = async () => {
      // Only fetch slots if service and professional are selected
      if (!bookingData.professionalId || !bookingData.serviceId) {
        setSlotsLoading(false);
        return;
      }

      if (!salonData?.id || !bookingData.date || !locationReady(locations, bookingData.locationId)) {
        setSlotsLoading(false);
        return;
      }
      // Too far ahead: nothing to ask (the message says why).
      if (isBeyondWindow(bookingData.date, lastDay)) {
        setSlotsLoading(false);
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
          undefined,
          // At that location (multi-local): the professional's times there.
          bookingData.locationId || undefined,
        );

        // An answer for inputs the client has since changed is not hers.
        if (cancelled) return;
        const offered = slots.map((slot) => ({
          time: slot.time,
          available: slot.isAvailable,
        }));
        setAvailableSlots(offered);
        // A time picked earlier stays only if this list still offers it
        // (after a failed booking the slot may have been taken).
        setBookingData((prev) =>
          prev.time && !isOfferedTime(prev.time, offered)
            ? { ...prev, time: "" }
            : prev,
        );
      } catch (error) {
        if (cancelled) return;
        console.error("Error fetching available slots:", error);
        toast({
          title: "Error",
          description: "No se pudieron cargar los horarios disponibles",
          variant: "destructive",
        });
      } finally {
        if (!cancelled) setSlotsLoading(false);
      }
    };

    setSlotsLoading(
      !!(bookingData.professionalId && bookingData.serviceId && bookingData.date),
    );

    // Debounce fetching slots
    const timer = setTimeout(() => {
      fetchAvailableSlots();
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // The date belongs here: with invented slots it made no difference, so
    // picking another day never refetched anything.
  }, [
    bookingData.professionalId,
    bookingData.serviceId,
    bookingData.date,
    bookingData.locationId,
    locations,
    salonData?.id,
    slotsRefresh,
    lastDay,
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
        // A new service keeps the professional if she does it (a
        // professional's QR code chose her), else the client picks again.
        professionalId:
          name === "serviceId"
            ? professionalAfterServiceChange(prev.professionalId, value, professionals)
            : value,
        time: "", // Clear selected time as well
      }));
    } else {
      setBookingData((prev) => ({
        ...prev,
        [name]: value,
      }));
    }
  };

  // Another location: what was picked stays only if it can be booked there.
  const handleLocationChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const locationId = e.target.value;
    setAvailableSlots([]);
    setBookingData((prev) => ({
      ...prev,
      locationId,
      ...choiceAtLocation(prev, bookableServices, professionals, locations, locationId),
      time: "",
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Only a time the server offered for the inputs on screen. A time picked
    // before changing the professional or the day used to stay selected and
    // go out with the new ones.
    if (!isOfferedTime(bookingData.time, availableSlots)) {
      setBookingData((prev) => ({ ...prev, time: "" }));
      toast({
        title: t("bookingPublic.select_time"),
        description: t("bookingPublic.slot_gone"),
        variant: "destructive",
      });
      return;
    }
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

      // One box for the name: first word, then the rest (may be empty).
      const { firstName, lastName } = splitClientName(bookingData.clientName);

      const booked = await apiClient.createAppointment({
        tenantId: salonData.id,
        // The public endpoint takes no clientId (an anonymous caller must not
        // book as someone else): it finds or creates the client by email or
        // phone in this salon.
        clientInfo: {
          firstName,
          lastName,
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
        // The location she booked at, when the salon has several.
        ...(bookingData.locationId ? { locationId: bookingData.locationId } : {}),
        // Only what she ticked: an unticked box sends nothing.
        ...(refusesMarketingEmail ? { refusesMarketingEmail: true } : {}),
        ...(offersWhatsAppNotices && wantsWhatsAppNotices ? { wantsWhatsAppNotices: true } : {}),
        ...(offersWhatsAppPromotions && wantsWhatsAppPromotions ? { wantsWhatsAppPromotions: true } : {}),
      });

      // Only now. The confirmation has to mean the appointment exists: a
      // summary that stays on screen, from what the server booked. At one of
      // several locations it says which one and where it is; otherwise the
      // salon's address. "Confirmada" only when the answer says so: by
      // default a salon confirms online bookings itself.
      const place =
        confirmedPlace(locations, bookingData.locationId, booked) ??
        (salonData.address ? { name: salonData.name, address: salonData.address } : null);
      const answer = booked as any;
      const service = services.find((s) => s.id === bookingData.serviceId);
      const professional = professionals.find((p) => p.id === bookingData.professionalId);
      const bookedPro = answer?.professional ?? professional;
      setConfirmation({
        confirmed: answer?.status === "confirmed",
        serviceName: answer?.service?.name ?? service?.name ?? "",
        professionalName: bookedPro ? `${bookedPro.firstName ?? ""} ${bookedPro.lastName ?? ""}`.trim() : "",
        date: answer?.scheduledDate ? String(answer.scheduledDate).slice(0, 10) : bookingData.date,
        time: answer?.scheduledTime ?? bookingData.time,
        place,
        email: bookingData.clientEmail.trim(),
        ref: typeof answer?.id === "string" ? answer.id.slice(0, 8) : "",
      });

      // Reset form, with tomorrow as the date again. The location stays: a
      // second booking is most likely at the same one.
      setBookingData((prev) => ({
        clientName: "",
        clientEmail: "",
        clientPhone: "",
        serviceId: "",
        // A professional's QR code keeps her for the next booking too.
        professionalId: pinnedProfessionalId,
        date: localTomorrow(),
        time: "",
        locationId: prev.locationId,
      }));
      setRefusesMarketingEmail(false);
      setWantsWhatsAppNotices(false);
      // The next person on this device (the salon's tablet) ticks her own.
      setWantsWhatsAppPromotions(false);
    } catch (error) {
      console.error("Error booking appointment:", error);
      // Pass the server's reason through. The slot may have been taken while
      // this form sat open, and "try again" tells the client nothing about
      // whether trying again would help.
      toast({
        title: "Error",
        description:
          (error instanceof Error && bookingErrorMessage(error.message)) ||
          t("bookingPublic.booking_failed"),
        variant: "destructive",
      });
      // Ask for the slots again: the one she picked may be gone, and the
      // list on screen would go on offering it.
      setSlotsRefresh((n) => n + 1);
    } finally {
      setLoading(false);
    }
  };

  // From the date's own parts: new Date("2026-11-01") is UTC midnight, the
  // day before west of Greenwich.
  const formatDate = (dateString: string) => formatBookingDate(dateString);

  // Filter professionals based on selected service
  // Which professionals can perform the chosen service.
  //
  // This compared each professional's free-text `specialties` against the
  // service's name and category. A professional created by the onboarding
  // wizard has `specialties: []`, and `[].some()` is false, so nobody
  // matched, no professional could be picked and no booking was possible.
  // Every salon that completed onboarding had an unbookable public page.
  //
  // The database had the answer all along, in ProfessionalService. Nothing
  // linked to this service: everyone rather than nobody -- an unbookable page
  // is the worse failure (professionalsForService). Then, with locations,
  // only who works at the chosen one (or at any, before one is chosen).
  const filteredProfessionals = professionalsAtLocation(
    professionalsForService(professionals, bookingData.serviceId),
    locations,
    bookingData.locationId,
  );
  // The services someone at the chosen location does.
  const servicesHere = servicesAtLocation(bookableServices, professionals, locations, bookingData.locationId);
  const locationHere = chosenLocation(locations, bookingData.locationId);
  // With a professional pinned by her QR code, only the services she does.
  const offeredServices = servicesForPinned(servicesHere, pinnedProfessional, professionals);

  // This refused every Sunday, for every salon, whatever its hours -- and
  // read the weekday from a UTC date, so west of Greenwich it refused
  // Mondays. The day is taken as picked; the server's slots say what is
  // free, and the salon's recorded hours only choose the message when
  // nothing is (see isClosedDay: a professional with no schedule recorded
  // is bookable any day, so the hours cannot veto a day on their own).
  const handleDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setBookingData((prev) => ({
      ...prev,
      date: e.target.value,
      time: "",
    }));
  };

  const slotsView = slotsState({
    serviceId: bookingData.serviceId,
    professionalId: bookingData.professionalId,
    date: bookingData.date,
    loading: slotsLoading,
    slots: availableSlots,
    closed: isClosedDay(bookingData.date, initialData.openingHours, closedDaysAt(initialData, bookingData.locationId)),
    lastDay,
  });

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
                    alt=""
                    width={24}
                    height={24}
                    className="w-6 h-6 rounded-full object-cover"
                  />
                </div>
              )}
              <span className="font-semibold text-gray-900">
                {salonData?.name}
              </span>
            </div>

          </div>
        </div>
      </nav>

      <div className="container mx-auto px-4 py-8 sm:py-12">
        {/* The salon's cover photo (Ajustes > Salón), as the page's header. */}
        {salonData.cover && (
          <div className="mb-8 -mt-2 overflow-hidden rounded-2xl bg-purple-100 shadow-sm">
            <img
              src={salonData.cover}
              alt={t("sites.coverAlt", { name: salonData.name })}
              width={1200}
              height={400}
              className="h-40 w-full object-cover sm:h-64"
            />
          </div>
        )}
        {/* Salon Header */}
        <div className="text-center mb-12">
          {salonData?.logo && (
            <div className="mx-auto w-24 h-24 bg-purple-100 rounded-full flex items-center justify-center mb-4">
              <img
                src={salonData.logo}
                alt={t("sites.logoAlt", { name: salonData.name })}
                width={64}
                height={64}
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
            {salonData.phone && phoneHref && (
              <a href={phoneHref} className="flex items-center space-x-1 hover:text-purple-700">
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
            {salonData.social.map((link) => {
              const Icon = link.network === "instagram" ? Instagram : Facebook;
              return (
                <a
                  key={link.network}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center space-x-1 hover:text-purple-700"
                >
                  <Icon className="w-4 h-4 text-purple-600" />
                  <span>{link.label}</span>
                </a>
              );
            })}
          </address>
        </div>

        {/* Booking Form */}
        <div className="max-w-4xl mx-auto">
          {/* No online booking while the salon is read-only: its phone. */}
          {!takesBookings && (
            <div data-test="booking-unavailable" className="bg-white rounded-2xl shadow-lg p-4 sm:p-8 text-center">
              <h2 className="text-2xl font-bold text-purple-900 mb-3">{t("sites.noOnlineBookingTitle")}</h2>
              <p className="text-gray-700">{t("sites.noOnlineBooking")}</p>
              {phoneHref && (
                <a
                  href={phoneHref}
                  className="mt-6 inline-flex items-center gap-2 rounded-lg bg-purple-600 px-6 py-3 font-medium text-white hover:bg-purple-700"
                >
                  <Phone className="w-4 h-4" aria-hidden="true" />
                  {t("sites.callSalon", { phone: salonData.phone })}
                </a>
              )}
            </div>
          )}
          {takesBookings && (
          <div className="bg-white rounded-2xl shadow-lg p-4 sm:p-8">
            <h2 className="text-2xl font-bold text-purple-900 mb-6 text-center">
              {t("bookingPublic.title")}
            </h2>

            {confirmation ? (
              <div
                ref={doneRef}
                tabIndex={-1}
                role="status"
                aria-live="polite"
                data-test="booking-done"
                className="space-y-5 text-center outline-none"
              >
                <CheckCircle className="mx-auto h-12 w-12 text-green-600" aria-hidden="true" />
                <div>
                  <h3 className="text-xl font-semibold text-gray-900">{t("bookingPublic.booking_received")}</h3>
                  <p data-test="booking-done-status" className="mt-1 text-gray-700">
                    {confirmation.confirmed ? t("bookingPublic.status_confirmed") : t("bookingPublic.status_pending")}
                  </p>
                </div>
                <dl className="mx-auto grid max-w-md grid-cols-[auto,1fr] gap-x-4 gap-y-1 rounded-lg bg-purple-50 p-4 text-left text-sm">
                  <dt className="text-gray-500">{t("bookingPublic.summary_service")}</dt>
                  <dd className="font-medium text-gray-900">{confirmation.serviceName}</dd>
                  {confirmation.professionalName && (
                    <>
                      <dt className="text-gray-500">{t("bookingPublic.summary_professional")}</dt>
                      <dd className="font-medium text-gray-900">{confirmation.professionalName}</dd>
                    </>
                  )}
                  <dt className="text-gray-500">{t("bookingPublic.summary_date")}</dt>
                  <dd className="font-medium text-gray-900">{formatDate(confirmation.date)}</dd>
                  <dt className="text-gray-500">{t("bookingPublic.summary_time")}</dt>
                  <dd className="font-medium text-gray-900">{confirmation.time}</dd>
                </dl>
                {confirmation.place && (
                  <p data-test="booking-done-place" className="text-sm text-gray-700">
                    {confirmation.place.address
                      ? t("bookingPublic.booked_at_address", {
                          location: confirmation.place.name,
                          address: confirmation.place.address,
                        })
                      : t("bookingPublic.booked_at", { location: confirmation.place.name })}
                  </p>
                )}
                {confirmation.email && (
                  <p className="text-sm text-gray-600">
                    {t("bookingPublic.done_email", { email: confirmation.email })}
                  </p>
                )}
                {salonData.phone && (
                  <p data-test="booking-done-phone" className="text-sm text-gray-600">
                    {t("bookingPublic.done_phone")}{" "}
                    <a href={`tel:${salonData.phone.replace(/\s+/g, "")}`} className="font-medium text-purple-700 underline">
                      {salonData.phone}
                    </a>
                  </p>
                )}
                {confirmation.ref && (
                  <p className="text-xs text-gray-400">{t("bookingPublic.done_ref", { ref: confirmation.ref })}</p>
                )}
                <button
                  type="button"
                  data-test="booking-another"
                  onClick={() => setConfirmation(null)}
                  className="rounded-lg bg-purple-600 px-6 py-3 font-medium text-white hover:bg-purple-700"
                >
                  {t("bookingPublic.book_another")}
                </button>
              </div>
            ) : (
            <>
            {pinnedProfessional && (
              <div
                data-test="booking-pinned-professional"
                className="mb-6 flex flex-col gap-2 rounded-lg border border-purple-200 bg-purple-50 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-semibold text-purple-900">
                    {t("bookingPublic.with_professional", { name: pinnedProfessional.firstName })}
                  </p>
                  <p className="text-sm text-purple-800">
                    {t("bookingPublic.with_professional_hint", { name: pinnedProfessional.firstName })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPinnedProfessionalId("")}
                  className="text-sm text-purple-700 underline"
                >
                  {t("bookingPublic.all_professionals")}
                </button>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-8">
              {/* Step 1: Client Information */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-gray-900 flex items-center">
                  <User className="w-5 h-5 mr-2 text-purple-600" />
                  {t("bookingPublic.step_4")}
                </h3>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label
                        htmlFor="clientName"
                        className="block text-sm font-medium text-gray-700 mb-1"
                      >
                        {t("bookingPublic.full_name")} *
                      </label>
                      <input
                        type="text"
                        id="clientName"
                        name="clientName"
                        value={bookingData.clientName}
                        onChange={handleInputChange}
                        required
                        autoComplete="name"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                        placeholder={t("bookingPublic.name_placeholder")}
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
                        autoComplete="email"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                        placeholder={t("bookingPublic.email_placeholder")}
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
                        autoComplete="tel"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                        placeholder="+34 600 123 456"
                      />
                    </div>
                  </div>
              </div>

              {/* The location, when the salon has several to book at. It can
                  also be left for later: picking a professional sets it. */}
              {locations.length > 0 && (
                <div className="space-y-4">
                  <h3 id="booking-location-heading" className="text-lg font-semibold text-gray-900 flex items-center">
                    <MapPin className="w-5 h-5 mr-2 text-purple-600" aria-hidden="true" />
                    {t("bookingPublic.step_location")}
                  </h3>
                  <select
                    id="locationId"
                    aria-labelledby="booking-location-heading"
                    data-test="booking-location"
                    name="locationId"
                    value={bookingData.locationId}
                    onChange={handleLocationChange}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                  >
                    <option value="">-- {t("bookingPublic.select_location")} --</option>
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                        {location.address ? ` · ${location.address}` : ""}
                      </option>
                    ))}
                  </select>
                  {locationHere?.address && (
                    <p data-test="booking-location-address" className="text-sm text-gray-500 flex items-center">
                      <MapPin className="w-4 h-4 mr-1 text-purple-600" />
                      {locationHere.address}
                    </p>
                  )}
                </div>
              )}

              {/* Step 2: Service Selection */}
              <div className="space-y-4">
                <h3 id="booking-service-heading" className="text-lg font-semibold text-gray-900 flex items-center">
                  <Scissors className="w-5 h-5 mr-2 text-purple-600" aria-hidden="true" />
                  {t("bookingPublic.step_1")}
                </h3>

                <select
                  id="serviceId"
                  aria-labelledby="booking-service-heading"
                  data-test="booking-service"
                  name="serviceId"
                  value={bookingData.serviceId}
                  onChange={handleInputChange}
                  required
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors"
                >
                  <option value="">-- {t("bookingPublic.select_service")} --</option>
                  {offeredServices.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name} -{" "}
                      {priceOnRequest(service.price)
                        ? t("sites.priceOnRequest")
                        : formatPrice(service.price, salonData.currency)}{" "}
                      ({service.duration} min)
                    </option>
                  ))}
                </select>
                {taxIncluded && (
                  <p data-test="booking-tax-included" className="text-xs text-gray-500">
                    {taxIncluded}
                  </p>
                )}
              </div>

              {/* Step 3: Professional Selection */}
              <div className="space-y-4">
                <h3 id="booking-professional-heading" className="text-lg font-semibold text-gray-900 flex items-center">
                  <User className="w-5 h-5 mr-2 text-purple-600" aria-hidden="true" />
                  {t("bookingPublic.step_2")}
                </h3>

                {bookingData.serviceId ? (
                  <div role="group" aria-labelledby="booking-professional-heading" className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                    {filteredProfessionals.map((professional) => (
                      <button
                        key={professional.id}
                        type="button"
                        // The choice is said, not only shown in colour.
                        aria-pressed={bookingData.professionalId === professional.id}
                        onClick={() =>
                          setBookingData((prev) => ({
                            ...prev,
                            professionalId: professional.id,
                            // Her times, not the previous professional's.
                            time:
                              prev.professionalId === professional.id
                                ? prev.time
                                : "",
                            // No location chosen yet: hers (her main one
                            // when she works at several).
                            locationId: locationForProfessional(professional, locations, prev.locationId),
                          }))
                        }
                        className={`p-4 border rounded-lg transition-colors text-left ${
                          bookingData.professionalId === professional.id
                            ? "border-purple-500 bg-purple-50"
                            : "border-gray-200 hover:border-purple-300"
                        }`}
                      >
                        <div className="flex items-center space-x-3">
                          <div className="w-12 h-12 shrink-0 rounded-full bg-purple-100 flex items-center justify-center">
                            {professional.profileImage ? (
                              <img
                                src={professional.profileImage}
                                alt=""
                                width={48}
                                height={48}
                                loading="lazy"
                                className="w-12 h-12 rounded-full object-cover"
                              />
                            ) : (
                              <User className="w-6 h-6 text-purple-600" aria-hidden="true" />
                            )}
                          </div>
                          <div className="min-w-0 break-words">
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
                  <Calendar className="w-5 h-5 mr-2 text-purple-600" aria-hidden="true" />
                  <label htmlFor="date">{t("bookingPublic.step_3")}</label>
                </h3>

                <input
                  type="date"
                  id="date"
                  data-test="booking-date"
                  name="date"
                  value={bookingData.date}
                  onChange={handleDateChange}
                  required
                  min={today || undefined}
                  // No later than the service can be booked online.
                  max={lastDay || undefined}
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
                <h3 id="booking-time-heading" className="text-lg font-semibold text-gray-900 flex items-center">
                  <Clock className="w-5 h-5 mr-2 text-purple-600" aria-hidden="true" />
                  {t("bookingPublic.select_time")}
                </h3>

                {slotsView === "ready" ? (
                  <div role="group" aria-labelledby="booking-time-heading" className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                    {availableSlots.map((slot, index) => (
                      <button
                        key={index}
                        type="button"
                        aria-pressed={bookingData.time === slot.time}
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
                  <div className="text-center py-8 text-gray-500" aria-live="polite">
                    {slotsView === "beyond_window" && lastDay
                      ? t("bookingPublic.beyond_window", { date: formatDate(lastDay) })
                      : t(`bookingPublic.${slotsView}`)}
                  </div>
                )}
              </div>

              {/* What she chooses about promotions and notices: both
                  unticked, recorded with the booking (BOOKING_CHOICE_TEXT). */}
              <div className="space-y-3 text-sm text-gray-700">
                {offersWhatsAppNotices && (
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={wantsWhatsAppNotices}
                      onChange={(e) => setWantsWhatsAppNotices(e.target.checked)}
                      className="mt-0.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                    />
                    <span>{BOOKING_CHOICE_TEXT.whatsappNotices}</span>
                  </label>
                )}
                {offersWhatsAppPromotions && (
                  <div>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={wantsWhatsAppPromotions}
                        onChange={(e) => setWantsWhatsAppPromotions(e.target.checked)}
                        aria-describedby="booking-whatsapp-promotions-notice"
                        className="mt-0.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                      />
                      <span>{whatsappPromotionsLabel(initialData.name)}</span>
                    </label>
                    <p id="booking-whatsapp-promotions-notice" className="mt-1 ml-6 text-xs text-gray-500">
                      {BOOKING_CHOICE_TEXT.whatsappPromotionsNotice}
                    </p>
                  </div>
                )}
                <div>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={refusesMarketingEmail}
                      onChange={(e) => setRefusesMarketingEmail(e.target.checked)}
                      aria-describedby="booking-marketing-notice"
                      className="mt-0.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                    />
                    <span>{BOOKING_CHOICE_TEXT.emailRefusal}</span>
                  </label>
                  <p id="booking-marketing-notice" className="mt-1 ml-6 text-xs text-gray-500">
                    {BOOKING_CHOICE_TEXT.emailNotice}
                  </p>
                </div>
              </div>

              {/* Submit Button */}
              <div className="pt-4 space-y-3">
                <button
                  type="submit"
                  disabled={loading || !isOfferedTime(bookingData.time, availableSlots)}
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
                {/* The form asks for name, phone and email: say who uses
                    them and what for (RGPD art. 13), where they are given. */}
                <p className="text-xs text-gray-500 text-center">
                  {t("bookingPublic.privacy_notice", { salon: salonData.name })}{" "}
                  <a
                    href={privacyPolicyUrl()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-purple-700"
                  >
                    {t("bookingPublic.privacy_link")}
                  </a>
                </p>
              </div>
            </form>
            </>
            )}
          </div>
          )}

          {/* Salon Information Section. Every service with its price and
              every professional are in the HTML (no "show more" that only
              renders on click): this is what a search engine reads. */}
          <section className="mt-8 bg-white rounded-2xl shadow-lg p-4 sm:p-8">
            <h2 className="text-xl font-bold text-purple-900 mb-4">
              {t("sites.about", { name: salonData.name })}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h3 className="font-semibold text-gray-900 mb-2">
                  {t("sites.ourServices")}
                </h3>
                {taxIncluded && (
                  <p data-test="price-list-tax-included" className="-mt-1 mb-2 text-xs text-gray-500">
                    {taxIncluded}
                  </p>
                )}
                <ul className="space-y-2 text-gray-600">
                  {services.map((service) => (
                    <li key={service.id} className="flex items-start justify-between gap-4">
                      <span className="flex min-w-0 items-start space-x-2">
                        <span className="mt-2 w-2 h-2 shrink-0 bg-purple-500 rounded-full" />
                        <span className="min-w-0 break-words">
                          <span className="text-gray-800">{service.name}</span>
                          {service.description && (
                            <span className="block text-xs text-gray-500">{service.description}</span>
                          )}
                          {/* Not in the form: say why, and how to book it. */}
                          {!service.isOnlineBookable && (
                            <span data-test="price-list-phone-only" className="block text-xs text-purple-700">
                              {phoneHref ? (
                                <a href={phoneHref} className="underline hover:text-purple-900">
                                  {t("sites.phoneOnly")}
                                </a>
                              ) : (
                                t("sites.phoneOnly")
                              )}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="whitespace-nowrap text-sm">
                        {priceOnRequest(service.price)
                          ? t("sites.priceOnRequest")
                          : formatPrice(service.price, salonData.currency)}
                        <span className="text-gray-500"> · {service.duration} min</span>
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
                      {t("sites.hours")}
                    </h3>
                    <table className="text-sm text-gray-600">
                      <tbody>
                        {hoursRows.map((row) => (
                          <tr key={row.key}>
                            <td className="pr-6 py-0.5">{t(`sites.days.${row.key}`)}</td>
                            <td className="py-0.5">{row.hours ?? t("sites.closed")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* The salon's own words; plain text, never HTML. */}
                {initialData.cancellationPolicy && (
                  <div data-test="cancellation-policy">
                    <h3 className="font-semibold text-gray-900 mb-2">{t("sites.cancellationPolicy")}</h3>
                    <p className="whitespace-pre-line break-words text-sm text-gray-600">
                      {initialData.cancellationPolicy}
                    </p>
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
                              <span className="text-gray-500"> · {professional.position}</span>
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
                {/* Everyone: there was a cut at six with no way to see the rest. */}
                {professionals.map((professional) => (
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
                          width={96}
                          height={96}
                          loading="lazy"
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
                    <div className="p-4 min-w-0 break-words">
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
                        {/* "> 0": a 0 rendered as a stray "0". */}
                        {(professional.yearsExperience ?? 0) > 0 && (
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
                                  width={48}
                                  height={48}
                                  loading="lazy"
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

          {salonData?.id && <PublicReviewsSection tenantId={salonData.id} initial={initialReviews} t={t} />}
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
                type="button"
                aria-pressed={language === "es"}
                onClick={() => {
                  setLanguage("es");
                  rememberLanguage("es");
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
                type="button"
                aria-pressed={language === "en"}
                onClick={() => {
                  setLanguage("en");
                  rememberLanguage("en");
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

      {/* Virtual Receptionist Widget: it books, so not while the salon
          takes no bookings (it would be refused at the end too). */}
      {salonData && takesBookings && (
        <ChatWidget salonId={salonData.id} />
      )}
    </div>
  );
}


