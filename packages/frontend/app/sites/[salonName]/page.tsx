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
  Store,
} from "lucide-react";
import apiClient, { ApiError, removeToken } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { useTenantTranslations } from "@/lib/use-translation";
import LoginModal from "./components/login-modal";
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
  logo: string;
}

interface Professional {
  id: string;
  firstName: string;
  lastName: string;
  specialties: string[];
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

export default function SalonBookingPage({
  params,
}: {
  params: { salonName: string };
}) {
  const { toast } = useToast();
  const {
    t,
    isLoading: translationsLoading,
    language,
    setLanguage,
  } = useTenantTranslations();
  const [loading, setLoading] = useState(false);
  const [salonData, setSalonData] = useState<SalonData | null>(null);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [availableSlots, setAvailableSlots] = useState<AvailableTimeSlot[]>([]);
  const [showAllServices, setShowAllServices] = useState(false);
  const [showAllProfessionals, setShowAllProfessionals] = useState(false);
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
  const [tenantNotFound, setTenantNotFound] = useState(false);
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

  // Set default date to today + 1 day
  useEffect(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setBookingData((prev) => ({
      ...prev,
      date: tomorrow.toISOString().split("T")[0],
    }));
  }, []);

  // Fetch salon data, professionals, and services

  useEffect(() => {
    const fetchSalonData = async () => {
      try {
        setLoading(true);
        
        // 1) Resolve the URL slug to the real tenant via the public endpoint.
        const tenant = await apiClient.getPublicTenant(params.salonName);
        
        const resolvedSalon: SalonData = {
          id: tenant.id,
          name: tenant.name,
          description: tenant.description ?? "",
          address: [tenant.address, tenant.city, tenant.state, tenant.country]
            .filter(Boolean)
            .join(", "),
          phone: tenant.phone ?? "",
          email: tenant.email ?? "",
          logo: tenant.logo ?? "/api/placeholder/100/100",
        };
        
        // 2) Fetch professionals and services using the resolved tenant id.
        //    Use the PUBLIC endpoints so unauthenticated visitors do not 401.
        const [professionalsData, servicesData] = await Promise.all([
          apiClient.getProfessionalsPublic(tenant.id),
          apiClient.getServices(tenant.id),
        ]);
        
        setSalonData(resolvedSalon);
        setProfessionals(professionalsData);
        setServices(servicesData);
      } catch (error) {
        console.error("Error fetching salon data:", error);
        // 404 from the tenant lookup means the salon slug does not exist.
        // Show a friendly salon-not-found page instead of a destructive toast.
        if (error instanceof ApiError && error.status === 404) {
          setTenantNotFound(true);
        } else {
          toast({
            title: "Error",
            description: "No se pudo cargar la información del salón",
            variant: "destructive",
          });
        }
      } finally {
        setLoading(false);
      }
    };

    fetchSalonData();
  }, [params.salonName]);

  // Fetch available time slots
  useEffect(() => {
    const fetchAvailableSlots = async () => {
      // Only fetch slots if service and professional are selected
      if (!bookingData.professionalId || !bookingData.serviceId) {
        setAvailableSlots([]);
        return;
      }

      try {
        // TODO: Implement API endpoint for available slots
        // For now, use consistent available slots for all professionals
        const mockSlots: AvailableTimeSlot[] = [];
        for (let hour = 9; hour <= 19; hour++) {
          for (let minute = 0; minute < 60; minute += 30) {
            const timeStr = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
            mockSlots.push({
              time: timeStr,
              available: true, // All slots available for demo purposes
            });
          }
        }

        setAvailableSlots(mockSlots);
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
  }, [bookingData.professionalId, bookingData.serviceId]);

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
      // TODO: Implement booking API endpoint
      const appointmentData = {
        ...bookingData,
        clientId: currentUser?.id,
        clientInfo: currentUser
          ? undefined
          : {
              firstName: bookingData.clientName.split(" ")[0],
              lastName: bookingData.clientName.split(" ").slice(1).join(" "),
              email: bookingData.clientEmail,
              phone: bookingData.clientPhone,
            },
      };

      console.log("Booking data:", appointmentData);

      // Simulate API call
      await new Promise((resolve) => setTimeout(resolve, 1500));

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
      toast({
        title: "Error",
        description:
          "No se pudo reservar la cita. Por favor, intenta nuevamente.",
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
  const filteredProfessionals = bookingData.serviceId
    ? professionals.filter((pro) =>
        pro.specialties.some(
          (spec) =>
            services
              .find((s) => s.id === bookingData.serviceId)
              ?.category.toLowerCase()
              .includes(spec.toLowerCase()) ||
            services
              .find((s) => s.id === bookingData.serviceId)
              ?.name.toLowerCase()
              .includes(spec.toLowerCase()),
        ),
      )
    : [];

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

  if ((loading || translationsLoading) && !salonData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="animate-spin w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full"></div>
        <span className="ml-4 text-gray-600">{t("common.loading")}</span>
      </div>
    );
  }

  if (tenantNotFound) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 via-white to-pink-50 px-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center">
          <div className="mx-auto w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mb-4">
            <Store className="w-8 h-8 text-purple-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">
            {t("sites.notFoundTitle")}
          </h1>
          <p className="text-gray-600 mb-6">
            {t("sites.notFoundDesc", { name: params.salonName })}
          </p>
        </div>
      </div>
    );
  }


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
                    href={`/sites/${params.salonName}/account`}
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
          <p className="text-gray-600 mb-6">{salonData?.description}</p>
          <div className="flex justify-center items-center space-x-6 text-sm text-gray-500">
            <span className="flex items-center space-x-1">
              <MapPin className="w-4 h-4 text-purple-600" />
              {salonData?.address}
            </span>
            <span className="flex items-center space-x-1">
              <Phone className="w-4 h-4 text-purple-600" />
              {salonData?.phone}
            </span>
            <span className="flex items-center space-x-1">
              <Mail className="w-4 h-4 text-purple-600" />
              {salonData?.email}
            </span>
          </div>
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
                      {currentUser.phone && (
                        <p className="text-sm text-green-700">
                          <strong>{t("common.phone")}:</strong> {currentUser.phone}
                      </p>
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
                        {t("bookingPublic.email")} *
                      </label>
                      <input
                        type="email"
                        id="clientEmail"
                        name="clientEmail"
                        value={bookingData.clientEmail}
                        onChange={handleInputChange}
                        required
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
                      {service.name} - {service.price}€ ({service.duration} min)
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

          {/* Salon Information Section */}
          <div className="mt-8 bg-white rounded-2xl shadow-lg p-8">
            <h3 className="text-xl font-bold text-purple-900 mb-4">
              {t("sites.about", { name: salonData?.name })}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h4 className="font-semibold text-gray-900 mb-2">
                  {t("sites.ourServices")}
                </h4>
                <ul className="space-y-2 text-gray-600">
                  {(showAllServices ? services : services.slice(0, 5)).map(
                    (service) => (
                      <li
                        key={service.id}
                        className="flex items-center space-x-2"
                      >
                        <span className="w-2 h-2 bg-purple-500 rounded-full" />
                        <span>
                          {service.name} - {service.price}€
                        </span>
                      </li>
                    ),
                  )}
                  {services.length > 5 && (
                    <li className="text-sm">
                      <button
                        type="button"
                        onClick={() => setShowAllServices(!showAllServices)}
                        className="text-purple-600 hover:text-purple-700 font-medium"
                      >
                        {showAllServices
                          ? `${t("sites.showLess")} (${services.slice(0, 5).length})`
                          : t("sites.showMore", { count: services.length - 5 })}
                      </button>
                    </li>
                  )}
                </ul>
              </div>

              <div>
                <h4 className="font-semibold text-gray-900 mb-2">
                  {t("sites.ourProfessionals")}
                </h4>
                <ul className="space-y-2 text-gray-600">
                  {(showAllProfessionals
                    ? professionals
                    : professionals.slice(0, 5)
                  ).map((professional) => (
                    <li
                      key={professional.id}
                      className="flex items-center space-x-2"
                    >
                      <span className="w-2 h-2 bg-purple-500 rounded-full" />
                      <span>
                        {professional.firstName} {professional.lastName}
                      </span>
                    </li>
                  ))}
                  {professionals.length > 5 && (
                    <li className="text-sm">
                      <button
                        type="button"
                        onClick={() =>
                          setShowAllProfessionals(!showAllProfessionals)
                        }
                        className="text-purple-600 hover:text-purple-700 font-medium"
                      >
                        {showAllProfessionals
                          ? `${t("sites.showLess")} (${professionals.slice(0, 5).length})`
                          : t("sites.showMore", { count: professionals.length - 5 })}
                      </button>
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </div>

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
          clientId={currentUser?.id ?? "anonymous"}
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


