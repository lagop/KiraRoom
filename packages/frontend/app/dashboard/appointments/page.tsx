"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import {
  Search,
  Plus,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Clock,
  User,
  CheckCircle,
  XCircle,
  AlertCircle,
  Eye,
  ChevronDown,
} from "lucide-react";
import apiClient, { Appointment as ApiAppointment } from "../../../lib/api";
import { useTranslations } from "@/lib/use-translation";
import { Calendar as CalendarComponent } from "../../../components/Calendar/Calendar";
import { AppointmentDrawer } from "./components/appointment-drawer";

type AppointmentStatus =
  | "confirmed"
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

interface Appointment extends ApiAppointment {
  client?:
    | string
    | {
        id: string;
        firstName: string;
        lastName: string;
        email?: string;
        phone?: string;
      };
  professional?: string | { id: string; firstName: string; lastName: string };
  service?: string | { id: string; name: string };
}

// Types for Calendar component
type Professional = {
  id: string;
  name: string;
  avatarUrl?: string;
};

type CalendarAppointment = {
  id: string;
  professionalId: string;
  clientName?: string;
  serviceName?: string;
  start: string; // ISO
  end: string; // ISO
  type: "appointment" | "lunch" | "blocked";
};

const getClientName = (client: Appointment["client"]) => {
  if (!client) return "Unknown";
  if (typeof client === "string") return client;
  return `${client.firstName} ${client.lastName}`;
};

const getClientEmail = (client: Appointment["client"]) => {
  if (!client || typeof client === "string") return "";
  return client.email || "";
};

const getClientPhone = (client: Appointment["client"]) => {
  if (!client || typeof client === "string") return "";
  return client.phone || "";
};

const getServiceName = (service: Appointment["service"]) => {
  if (!service) return "Unknown";
  if (typeof service === "string") return service;
  return service.name;
};

// Get all service names for multi-service appointments
const getAllServiceNames = (appointment: Appointment) => {
  // First check if there are multiple services
  if (appointment.services && appointment.services.length > 0) {
    const names = appointment.services
      .map((s) => s.service?.name || "Unknown")
      .filter(Boolean);
    if (names.length > 0) {
      return names;
    }
  }
  // Fallback to single service
  return [getServiceName(appointment.service)];
};

const getProfessionalName = (professional: Appointment["professional"]) => {
  if (!professional) return "Unknown";
  if (typeof professional === "string") return professional;
  return `${professional.firstName} ${professional.lastName}`;
};

// Get all professional names for multi-service appointments
const getAllProfessionalNames = (appointment: Appointment) => {
  // First check if there are multiple services with professionals
  if (appointment.services && appointment.services.length > 0) {
    const names: string[] = [];
    appointment.services.forEach((s) => {
      if (s.professional) {
        names.push(`${s.professional.firstName} ${s.professional.lastName}`);
      }
    });
    if (names.length > 0) {
      // Remove duplicates
      return Array.from(new Set(names));
    }
  }
  // Fallback to single professional
  return [getProfessionalName(appointment.professional)];
};

// Calculate total price from all services for multi-service appointments
const getTotalPrice = (appointment: Appointment) => {
  // totalAmount is in cents from backend, convert to dollars
  if (appointment.totalAmount && Number(appointment.totalAmount) > 0) {
    return (Number(appointment.totalAmount) / 100).toFixed(2);
  }
  // Fallback: compute from service prices (in dollars)
  if (appointment.services && appointment.services.length > 0) {
    const total = appointment.services.reduce((sum, s) => {
      const servicePrice = Number(s.service?.price) || 0;
      return sum + servicePrice;
    }, 0);
    if (total > 0) {
      return total.toFixed(2);
    }
  }
  // Single service fallback (price is in dollars)
  return (Number(appointment.price) || 0).toFixed(2);
};

export default function AppointmentsPage() {
  const searchParams = useSearchParams();
  const t = useTranslations();
  const today = new Date().toISOString().split("T")[0];
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<"list" | "calendar">("list");
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [professionalFilter, setProfessionalFilter] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus[] | "">(
    [],
  );
  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const [dateFilter, setDateFilter] = useState(today);
  const [selectedAppointmentId, setSelectedAppointmentId] = useState<
    string | null
  >(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerRefreshKey, setDrawerRefreshKey] = useState(0);

  // Client search feature for list view
  const [clientSearchOpen, setClientSearchOpen] = useState(false);
  const [clientSearchTerm, setClientSearchTerm] = useState("");
  const [clientSearchResults, setClientSearchResults] = useState<Appointment[]>(
    [],
  );
  const [isSearchingClient, setIsSearchingClient] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // Check for ?new=true query parameter to open new appointment drawer
  useEffect(() => {
    if (searchParams?.get("new") === "true") {
      setSelectedAppointmentId(null);
      setDrawerOpen(true);
    }
  }, [searchParams]);

  const fetchAppointments = async () => {
    try {
      const data = await apiClient.getAppointments();
      setAppointments(data as unknown as Appointment[]);
    } catch (error) {
      console.error("Error fetching appointments:", error);
      // Fallback to mock data if API fails
      setAppointments([
        {
          id: "1",
          scheduledDate: "2026-01-06",
          scheduledTime: "10:00 AM",
          status: "completed",
          price: 65,
          client: "Sarah Johnson",
          professional: "John Smith",
          service: "Haircut & Styling",
          createdAt: "",
          updatedAt: "",
          tenantId: "",
          clientId: "",
          serviceId: "",
          professionalId: "",
          duration: 60,
          currency: "USD",
          paymentStatus: "pending",
        },
        {
          id: "2",
          scheduledDate: "2026-01-06",
          scheduledTime: "11:30 AM",
          status: "in_progress",
          price: 120,
          client: "Mike Chen",
          professional: "David Kim",
          service: "Full Body Massage",
          createdAt: "",
          updatedAt: "",
          tenantId: "",
          clientId: "",
          serviceId: "",
          professionalId: "",
          duration: 60,
          currency: "USD",
          paymentStatus: "pending",
        },
        {
          id: "3",
          scheduledDate: "2026-01-06",
          scheduledTime: "2:00 PM",
          status: "pending",
          price: 85,
          client: "Emily Davis",
          professional: "Lisa Brown",
          service: "Facial Treatment",
          createdAt: "",
          updatedAt: "",
          tenantId: "",
          clientId: "",
          serviceId: "",
          professionalId: "",
          duration: 60,
          currency: "USD",
          paymentStatus: "pending",
        },
        {
          id: "4",
          scheduledDate: "2026-01-06",
          scheduledTime: "3:30 PM",
          status: "confirmed",
          price: 55,
          client: "Alex Thompson",
          professional: "Maria Garcia",
          service: "Gel Nail Application",
          createdAt: "",
          updatedAt: "",
          tenantId: "",
          clientId: "",
          serviceId: "",
          professionalId: "",
          duration: 60,
          currency: "USD",
          paymentStatus: "pending",
        },
        {
          id: "5",
          scheduledDate: "2026-01-06",
          scheduledTime: "4:00 PM",
          status: "confirmed",
          price: 150,
          client: "Jessica Wilson",
          professional: "John Smith",
          service: "Hair Color & Highlights",
          createdAt: "",
          updatedAt: "",
          tenantId: "",
          clientId: "",
          serviceId: "",
          professionalId: "",
          duration: 60,
          currency: "USD",
          paymentStatus: "pending",
        },
        {
          id: "6",
          scheduledDate: "2026-01-07",
          scheduledTime: "9:00 AM",
          status: "confirmed",
          price: 140,
          client: "Robert Lee",
          professional: "David Kim",
          service: "Deep Tissue Massage",
          createdAt: "",
          updatedAt: "",
          tenantId: "",
          clientId: "",
          serviceId: "",
          professionalId: "",
          duration: 60,
          currency: "USD",
          paymentStatus: "pending",
        },
      ] as unknown as Appointment[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAppointments();
  }, [view]);

  const updateStatus = async (id: string, newStatus: AppointmentStatus) => {
    setUpdatingId(id);
    try {
      await apiClient.updateAppointment(id, { status: newStatus } as any);
      setAppointments((prev) =>
        prev.map((apt) =>
          apt.id === id ? { ...apt, status: newStatus } : apt,
        ),
      );
    } catch (error) {
      console.error("Error updating appointment status:", error);
    } finally {
      setUpdatingId(null);
    }
  };

  const getStatusBadge = (status: AppointmentStatus) => {
    const styles: Record<AppointmentStatus, string> = {
      confirmed: "bg-green-100 text-green-800",
      pending: "bg-yellow-100 text-yellow-800",
      in_progress: "bg-blue-100 text-blue-800",
      completed: "bg-purple-100 text-purple-800",
      cancelled: "bg-red-100 text-red-800",
      no_show: "bg-gray-100 text-gray-800",
    };

    const statusLabels: Record<AppointmentStatus, string> = {
      confirmed: t("appointments.status_confirmed"),
      pending: t("appointments.status_pending"),
      in_progress: t("appointments.status_in_progress"),
      completed: t("appointments.status_completed"),
      cancelled: t("appointments.status_cancelled"),
      no_show: t("appointments.no_show"),
    };

    const icons: Record<AppointmentStatus, React.ReactNode> = {
      confirmed: <CheckCircle className="w-3 h-3 mr-1" />,
      pending: <AlertCircle className="w-3 h-3 mr-1" />,
      in_progress: <Clock className="w-3 h-3 mr-1" />,
      completed: <CheckCircle className="w-3 h-3 mr-1" />,
      cancelled: <XCircle className="w-3 h-3 mr-1" />,
      no_show: <XCircle className="w-3 h-3 mr-1" />,
    };

    return (
      <span
        className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${styles[status]}`}
      >
        {icons[status]}
        {statusLabels[status]}
      </span>
    );
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  };

  const navigateMonth = (direction: "prev" | "next") => {
    setCurrentDate((prev) => {
      const newDate = new Date(prev);
      if (direction === "prev") {
        newDate.setMonth(newDate.getMonth() - 1);
      } else {
        newDate.setMonth(newDate.getMonth() + 1);
      }
      return newDate;
    });
  };

  // Handle client search for list view
  const handleClientSearch = () => {
    if (!clientSearchTerm.trim()) {
      setClientSearchResults([]);
      setHasSearched(false);
      return;
    }

    setIsSearchingClient(true);
    setHasSearched(true);
    const term = clientSearchTerm.toLowerCase();

    // Filter appointments by client name, email, or phone in the selected month
    const results = appointments.filter((apt) => {
      // Handle both string and object client formats
      let clientName = "";
      let clientEmail = "";
      let clientPhone = "";

      if (typeof apt.client === "string") {
        // Client is a string (name only)
        clientName = apt.client.toLowerCase();
      } else if (apt.client) {
        // Client is an object
        clientName =
          `${apt.client.firstName || ""} ${apt.client.lastName || ""}`
            .toLowerCase()
            .trim();
        clientEmail = (apt.client.email || "").toLowerCase();
        clientPhone = (apt.client.phone || "").toLowerCase();
      }

      // Check if matches search term
      const matchesSearch =
        clientName.includes(term) ||
        clientEmail.includes(term) ||
        clientPhone.includes(term);

      // Check if in selected month
      const appointmentDate = new Date(apt.scheduledDate);
      const inSelectedMonth =
        appointmentDate.getMonth() === currentDate.getMonth() &&
        appointmentDate.getFullYear() === currentDate.getFullYear();

      return matchesSearch && inSelectedMonth;
    });

    setClientSearchResults(results);
    setIsSearchingClient(false);
  };

  // Handle enter key press for client search
  const handleClientSearchKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleClientSearch();
    }
  };

  // Extract unique professionals and services for dropdowns
  const uniqueProfessionals = Array.from(
    new Set(appointments.flatMap((apt) => getAllProfessionalNames(apt))),
  ).sort();

  const uniqueServices = Array.from(
    new Set(appointments.flatMap((apt) => getAllServiceNames(apt))),
  ).sort();

  // Check if appointment is multi-service
  const isMultiService = (appointment: Appointment) => {
    if (appointment.services && appointment.services.length > 0) {
      return true;
    }
    // Fallback: check if service field indicates multiple services (comma-separated)
    if (
      appointment.service &&
      typeof appointment.service === "string" &&
      appointment.service.includes(",")
    ) {
      return true;
    }
    return false;
  };

  // Get unique professionals for an appointment (for multi-professional appointments)
  const getAppointmentProfessionals = (appointment: Appointment) => {
    if (appointment.services && appointment.services.length > 0) {
      const professionals = appointment.services
        .map((s) => {
          if (s.professional) {
            return `${s.professional.firstName} ${s.professional.lastName}`;
          }
          return null;
        })
        .filter(Boolean);
      return [...new Set(professionals)];
    }
    return [getProfessionalName(appointment.professional)];
  };

  // Get all service/professional combinations for an appointment
  const getServiceProfessionalCombinations = (appointment: Appointment) => {
    if (appointment.services && appointment.services.length > 0) {
      return appointment.services.map((s) => ({
        serviceName: s.service?.name || "Unknown",
        professionalName: s.professional
          ? `${s.professional.firstName} ${s.professional.lastName}`
          : "Unknown",
        duration: s.service?.duration || 0,
      }));
    }
    return [
      {
        serviceName: getServiceName(appointment.service),
        professionalName: getProfessionalName(appointment.professional),
        duration: appointment.duration || 0,
      },
    ];
  };

  // Get services for a specific professional in an appointment
  const getServicesForProfessional = (
    appointment: Appointment,
    professionalName: string,
  ) => {
    if (appointment.services && appointment.services.length > 0) {
      return appointment.services
        .filter((s) => {
          if (s.professional) {
            return (
              `${s.professional.firstName} ${s.professional.lastName}` ===
              professionalName
            );
          }
          return false;
        })
        .map((s) => s.service?.name || "Unknown");
    }
    return getAllServiceNames(appointment);
  };

  // Calculate total duration for services of a specific professional
  const getProfessionalServiceDuration = (
    appointment: Appointment,
    professionalName: string,
  ) => {
    if (appointment.services && appointment.services.length > 0) {
      return appointment.services
        .filter((s) => {
          if (s.professional) {
            return (
              `${s.professional.firstName} ${s.professional.lastName}` ===
              professionalName
            );
          }
          return false;
        })
        .reduce((sum, s) => sum + (s.service?.duration || 0), 0);
    }
    return appointment.duration || 0;
  };

  // Function to render calendar days
  const renderCalendarDays = () => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const days = [];

    // Add empty cells for days before the first day of the month
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className="p-2"></div>);
    }

    // Add cells for each day of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      const dateString = date.toISOString().split("T")[0];
      const dayAppointments = filteredAppointments.filter(
        (apt) => apt.scheduledDate === dateString,
      ).sort((a, b) => {
        const aPriority = getStatusPriority(a.status as AppointmentStatus);
        const bPriority = getStatusPriority(b.status as AppointmentStatus);
        if (aPriority !== bPriority) {
          return aPriority - bPriority;
        }
        // Same status, sort by time
        const aMinutes = parseTimeToMinutes(a.scheduledTime);
        const bMinutes = parseTimeToMinutes(b.scheduledTime);
        return aMinutes - bMinutes;
      });

      days.push(
        <div
          key={`day-${day}`}
          className="min-h-[120px] border border-gray-200 p-2 relative"
        >
          <div className="font-medium text-gray-900 mb-2">{day}</div>
          <div className="space-y-1">
            {dayAppointments.map((appointment) => {
              const isMulti = isMultiService(appointment);
              const professionals = getAppointmentProfessionals(appointment);
              const hasMultipleProfessionals = professionals.length > 1;

              // If multi-service, render separate cards for each service/professional combination
              if (isMulti) {
                const combinations =
                  getServiceProfessionalCombinations(appointment);
                return combinations.map((combo, idx) => (
                  <div
                    key={`${appointment.id}-${idx}`}
                    className={`p-1 rounded text-xs border-t-2 ${
                      appointment.status === "confirmed"
                        ? "bg-green-100 text-green-800 border-green-500"
                        : appointment.status === "pending"
                          ? "bg-yellow-100 text-yellow-800 border-yellow-500"
                          : appointment.status === "in_progress"
                            ? "bg-blue-100 text-blue-800 border-blue-500"
                            : appointment.status === "completed"
                              ? "bg-purple-100 text-purple-800 border-purple-500"
                              : "bg-red-100 text-red-800 border-red-500"
                    } ${isMulti ? "border-t-indigo-500" : ""}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-medium">
                        {appointment.scheduledTime}
                      </div>
                      {isMulti && (
                        <span
                          className="flex items-center"
                          title={t("appointments.multipleServices")}
                        >
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M4 6h16M4 10h16M4 14h16M4 18h16"
                            />
                          </svg>
                        </span>
                      )}
                    </div>
                    <div>{getClientName(appointment.client)}</div>
                    <div className="text-[10px] opacity-75">
                      {combo.serviceName}
                    </div>
                    <div className="text-[10px] opacity-75 font-medium">
                      {combo.professionalName} ({combo.duration}min)
                    </div>
                  </div>
                ));
              }

              // Single service - render as one card
              return (
                <div
                  key={appointment.id}
                  className={`p-1 rounded text-xs ${
                    appointment.status === "confirmed"
                      ? "bg-green-100 text-green-800"
                      : appointment.status === "pending"
                        ? "bg-yellow-100 text-yellow-800"
                        : appointment.status === "in_progress"
                          ? "bg-blue-100 text-blue-800"
                          : appointment.status === "completed"
                            ? "bg-purple-100 text-purple-800"
                            : "bg-red-100 text-red-800"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-medium">
                      {appointment.scheduledTime}
                    </div>
                    {isMulti && (
                      <span
                        className="flex items-center"
                        title={t("appointments.multipleServices")}
                      >
                        <svg
                          className="w-3 h-3"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M4 6h16M4 10h16M4 14h16M4 18h16"
                          />
                        </svg>
                      </span>
                    )}
                  </div>
                  <div>{getClientName(appointment.client)}</div>
                  <div>{getAllServiceNames(appointment).join(", ")}</div>
                  {isMulti && professionals.length === 1 && (
                    <div className="text-[10px] opacity-75 font-medium">
                      {professionals[0]} ({appointment.duration}min total)
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>,
      );
    }

    return days;
  };

  // Function to parse time string to minutes since midnight
  const parseTimeToMinutes = (timeStr: string): number => {
    const [time, period] = timeStr.split(' ');
    const [hours, minutes] = time.split(':').map(Number);
    let totalMinutes = hours * 60 + minutes;
    if (period === 'PM' && hours !== 12) totalMinutes += 12 * 60;
    if (period === 'AM' && hours === 12) totalMinutes = minutes;
    return totalMinutes;
  };

  // Function to check if appointment is at current time slot
  const isCurrentTimeSlot = (appointment: Appointment): boolean => {
    const currentHour = new Date().getHours();
    const appointmentMinutes = parseTimeToMinutes(appointment.scheduledTime);
    const appointmentHour = Math.floor(appointmentMinutes / 60);
    return appointmentHour === currentHour;
  };

  const filteredAppointments = appointments.filter((apt) => {
    // Search term filter - search by client name, email, or phone
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      const clientName = getClientName(apt.client).toLowerCase();
      const clientEmail = getClientEmail(apt.client).toLowerCase();
      const clientPhone = getClientPhone(apt.client).toLowerCase();
      const allProfessionalNames = getAllProfessionalNames(apt).map((n) =>
        n.toLowerCase(),
      );
      const serviceNames = getAllServiceNames(apt).map((n) => n.toLowerCase());
      if (
        !clientName.includes(term) &&
        !clientEmail.includes(term) &&
        !clientPhone.includes(term) &&
        !allProfessionalNames.some((name) => name.includes(term)) &&
        !serviceNames.some((name) => name.includes(term))
      ) {
        return false;
      }
    }

    // Professional filter
    if (professionalFilter) {
      const allProfessionalNames = getAllProfessionalNames(apt).map((n) =>
        n.toLowerCase(),
      );
      if (
        !allProfessionalNames.some((name) =>
          name.includes(professionalFilter.toLowerCase()),
        )
      ) {
        return false;
      }
    }

    // Service filter
    if (serviceFilter) {
      const serviceNames = getAllServiceNames(apt).map((n) => n.toLowerCase());
      if (
        !serviceNames.some((name) => name.includes(serviceFilter.toLowerCase()))
      ) {
        return false;
      }
    }

    // Status filter
    if (statusFilter && statusFilter.length > 0) {
      if (!statusFilter.includes(apt.status)) {
        return false;
      }
    }

    // Date filter (only apply if dateFilter is set)
    if (dateFilter && dateFilter.trim() !== "") {
      if (apt.scheduledDate.split("T")[0] !== dateFilter) {
        return false;
      }
    }

    // Month filter based on currentDate (only apply when client search is open)
    if (clientSearchOpen) {
      const appointmentDate = new Date(apt.scheduledDate);
      if (currentDate) {
        if (
          appointmentDate.getMonth() !== currentDate.getMonth() ||
          appointmentDate.getFullYear() !== currentDate.getFullYear()
        ) {
          return false;
        }
      }
    }

    return true;
  });

  // Sort appointments by status priority then by time (morning to evening)
  const getStatusPriority = (status: AppointmentStatus): number => {
    const priorities: Record<AppointmentStatus, number> = {
      pending: 1,
      confirmed: 2,
      in_progress: 3,
      completed: 4,
      cancelled: 5,
      no_show: 6,
    };
    return priorities[status] || 7;
  };

  const sortedAppointments = filteredAppointments.sort((a, b) => {
    const aPriority = getStatusPriority(a.status as AppointmentStatus);
    const bPriority = getStatusPriority(b.status as AppointmentStatus);
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    // Same status, sort by time
    const aMinutes = parseTimeToMinutes(a.scheduledTime);
    const bMinutes = parseTimeToMinutes(b.scheduledTime);
    return aMinutes - bMinutes;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {t("appointments.title")}
          </h1>
          <p className="text-gray-500 mt-1">{t("appointments.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center bg-gray-100 rounded-lg p-1">
            <button
              onClick={() => setView("list")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                view === "list"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {t("appointments.list")}
            </button>
            <button
              onClick={() => setView("calendar")}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                view === "calendar"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {t("appointments.calendar")}
            </button>
          </div>
          <button
            onClick={() => {
              setSelectedAppointmentId(null);
              setDrawerOpen(true);
            }}
            className="inline-flex items-center px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <Plus className="w-5 h-5 mr-2" />
            {t("appointments.new_appointment")}
          </button>
        </div>
      </div>

      {/* Calendar Navigation (for both views) */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        {/* Collapsible Search My Appointment Section */}
        {(
          <div>
            <button
              onClick={() => setClientSearchOpen(!clientSearchOpen)}
              className="w-full flex items-center justify-between py-2 hover:bg-gray-50 transition-colors rounded-lg px-2"
            >
              <div className="flex items-center">
                <Search className="w-5 h-5 text-gray-500 mr-2" />
                <span className="font-medium text-gray-700">
                  {t("appointments.find_client_appointment")}
                </span>
                <span className="ml-2 text-sm text-gray-500">
                  {t("appointments.search_by_name_email_phone")}
                </span>
              </div>
              {clientSearchOpen ? (
                <ChevronDown className="w-5 h-5 text-gray-500 transform rotate-180 transition-transform" />
              ) : (
                <ChevronDown className="w-5 h-5 text-gray-500 transition-transform" />
              )}
            </button>

            {clientSearchOpen && (
              <div className="mt-3">
                {/* Month Selector, Search Input and Button in same row */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:space-x-4">
                  {/* Month Selector */}
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => navigateMonth("prev")}
                      className="p-2 hover:bg-gray-100 rounded-lg"
                    >
                      <ChevronLeft className="w-5 h-5 text-gray-600" />
                    </button>
                    <div className="flex items-center">
                      <Calendar className="w-5 h-5 text-gray-400 mr-2" />
                      <span className="font-semibold text-gray-900">
                        {formatDate(currentDate)}
                      </span>
                    </div>
                    <button
                      onClick={() => navigateMonth("next")}
                      className="p-2 hover:bg-gray-100 rounded-lg"
                    >
                      <ChevronRight className="w-5 h-5 text-gray-600" />
                    </button>
                  </div>

                  {/* Search Input */}
                  <div className="flex-1 relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                    <input
                      type="text"
                      placeholder={t("appointments.enter_name_email_phone")}
                      value={clientSearchTerm}
                      onChange={(e) => setClientSearchTerm(e.target.value)}
                      onKeyPress={handleClientSearchKeyPress}
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    />
                  </div>

                  {/* Search Button */}
                  <button
                    onClick={handleClientSearch}
                    disabled={isSearchingClient}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50"
                  >
                    {isSearchingClient
                      ? t("appointments.searching")
                      : t("appointments.search")}
                  </button>
                </div>

                {/* Search Results */}
                {clientSearchResults.length > 0 && (
                  <div className="mt-4">
                    <p className="text-sm font-medium text-gray-700 mb-2">
                      {t("appointments.found_appointments_for", {
                        count: clientSearchResults.length,
                        date: formatDate(currentDate),
                      })}
                    </p>
                    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                      <div className="overflow-x-auto">
                      <table className="w-full min-w-[820px]">
                        <thead className="bg-gray-50 border-b border-gray-200">
                          <tr>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
                              {t("appointments.status")}
                            </th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
                              {t("appointments.client")}
                            </th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
                              {t("appointments.service")}
                            </th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
                              {t("appointments.professional")}
                            </th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
                              {t("appointments.date")} &{" "}
                              {t("appointments.time")}
                            </th>
                            <th className="text-left px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
                              {t("appointments.price")}
                            </th>
                            <th className="text-right px-4 py-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
                              <span className="flex items-center justify-end">
                                <User className="w-4 h-4" />
                              </span>
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {clientSearchResults.map((apt) => (
                            <tr key={apt.id} className="hover:bg-gray-50">
                              <td className="px-4 py-3">
                                {getStatusBadge(
                                  apt.status as AppointmentStatus,
                                )}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center">
                                  <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center flex-shrink-0">
                                    <User className="w-4 h-4 text-indigo-600" />
                                  </div>
                                  <div className="ml-3 min-w-0">
                                    <p className="font-medium text-gray-900 text-sm truncate max-w-[12rem]">
                                      {getClientName(apt.client)}
                                    </p>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-900">
                                {getAllServiceNames(apt).map((name, idx) => (
                                  <div key={idx}>{name}</div>
                                ))}
                              </td>
                              <td className="px-4 py-3 text-sm text-gray-600">
                                {getAllProfessionalNames(apt).map(
                                  (name, idx) => (
                                    <div key={idx}>{name}</div>
                                  ),
                                )}
                              </td>
                              <td className="px-4 py-3 whitespace-nowrap">
                                <div className="flex items-center text-sm text-gray-600">
                                  <Calendar className="w-4 h-4 mr-1 text-gray-400" />
                                  {apt.scheduledDate.split("T")[0]}
                                </div>
                                <div className="flex items-center text-sm text-gray-600 mt-1">
                                  <Clock className="w-4 h-4 mr-1 text-gray-400" />
                                  {apt.scheduledTime}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-sm font-medium text-gray-900">
                                ${getTotalPrice(apt)}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <button
                                  onClick={() => {
                                    setSelectedAppointmentId(apt.id);
                                    setDrawerOpen(true);
                                  }}
                                  className="p-2 text-indigo-600 hover:bg-indigo-100 rounded-lg"
                                  title={t("appointments.view_details")}
                                >
                                  <Eye className="w-5 h-5" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                    </div>
                  </div>
                )}

                {hasSearched &&
                  clientSearchTerm &&
                  clientSearchResults.length === 0 &&
                  !isSearchingClient && (
                    <div className="mt-4 p-4 bg-yellow-50 rounded-lg">
                      <p className="text-sm text-yellow-800">
                        {t("appointments.no_appointments_found", {
                          term: clientSearchTerm,
                          date: formatDate(currentDate),
                        })}
                      </p>
                    </div>
                  )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("appointments.professional")}
            </label>
            <select
              value={professionalFilter}
              onChange={(e) => setProfessionalFilter(e.target.value)}
              className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent ${
                professionalFilter ? "bg-blue-50" : ""
              }`}
            >
              <option value="">{t("appointments.all_professionals")}</option>
              {uniqueProfessionals.map((professional, index) => (
                <option key={index} value={professional}>
                  {professional}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("appointments.service")}
            </label>
            <select
              value={serviceFilter}
              onChange={(e) => setServiceFilter(e.target.value)}
              className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent ${
                serviceFilter ? "bg-blue-50" : ""
              }`}
            >
              <option value="">{t("appointments.all_services")}</option>
              {uniqueServices.map((service, index) => (
                <option key={index} value={service}>
                  {service}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("appointments.status")}
            </label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowStatusDropdown(!showStatusDropdown)}
                className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent flex items-center justify-between ${
                  statusFilter.length > 0 ? "bg-blue-50" : ""
                }`}
              >
                <span className="text-sm text-gray-700">
                  {statusFilter.length === 0
                    ? t("appointments.all_statuses")
                    : Array.isArray(statusFilter)
                      ? statusFilter.join(", ")
                      : t("appointments.all_statuses")}
                </span>
                <ChevronDown className="w-4 h-4 text-gray-400" />
              </button>
              {showStatusDropdown && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg">
                  <div className="p-2">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-700">
                        {t("appointments.all_statuses")}
                      </span>
                      <input
                        type="checkbox"
                        checked={statusFilter.length === 0}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setStatusFilter([]);
                          }
                        }}
                        className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                      />
                    </div>
                  </div>
                  <div className="border-t border-gray-200">
                    <div className="p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-700">
                          {t("appointments.status_confirmed")}
                        </span>
                        <input
                          type="checkbox"
                          value="confirmed"
                          checked={statusFilter.includes("confirmed")}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setStatusFilter(
                                Array.isArray(statusFilter)
                                  ? [...statusFilter, "confirmed"]
                                  : ["confirmed"],
                              );
                            } else {
                              setStatusFilter(
                                Array.isArray(statusFilter)
                                  ? statusFilter.filter(
                                      (s) => s !== "confirmed",
                                    )
                                  : [],
                              );
                            }
                          }}
                          className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="border-t border-gray-200">
                    <div className="p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-700">
                          {t("appointments.status_pending")}
                        </span>
                        <input
                          type="checkbox"
                          value="pending"
                          checked={statusFilter.includes("pending")}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setStatusFilter(
                                Array.isArray(statusFilter)
                                  ? [...statusFilter, "pending"]
                                  : ["pending"],
                              );
                            } else {
                              setStatusFilter(
                                Array.isArray(statusFilter)
                                  ? statusFilter.filter((s) => s !== "pending")
                                  : [],
                              );
                            }
                          }}
                          className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="border-t border-gray-200">
                    <div className="p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-700">
                          {t("appointments.status_in_progress")}
                        </span>
                        <input
                          type="checkbox"
                          value="in_progress"
                          checked={statusFilter.includes("in_progress")}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setStatusFilter(
                                Array.isArray(statusFilter)
                                  ? [...statusFilter, "in_progress"]
                                  : ["in_progress"],
                              );
                            } else {
                              setStatusFilter(
                                Array.isArray(statusFilter)
                                  ? statusFilter.filter(
                                      (s) => s !== "in_progress",
                                    )
                                  : [],
                              );
                            }
                          }}
                          className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="border-t border-gray-200">
                    <div className="p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-700">
                          {t("appointments.status_completed")}
                        </span>
                        <input
                          type="checkbox"
                          value="completed"
                          checked={statusFilter.includes("completed")}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setStatusFilter(
                                Array.isArray(statusFilter)
                                  ? [...statusFilter, "completed"]
                                  : ["completed"],
                              );
                            } else {
                              setStatusFilter(
                                Array.isArray(statusFilter)
                                  ? statusFilter.filter(
                                      (s) => s !== "completed",
                                    )
                                  : [],
                              );
                            }
                          }}
                          className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="border-t border-gray-200">
                    <div className="p-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-700">
                          {t("appointments.status_cancelled")}
                        </span>
                        <input
                          type="checkbox"
                          value="cancelled"
                          checked={statusFilter.includes("cancelled")}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setStatusFilter(
                                Array.isArray(statusFilter)
                                  ? [...statusFilter, "cancelled"]
                                  : ["cancelled"],
                              );
                            } else {
                              setStatusFilter(
                                Array.isArray(statusFilter)
                                  ? statusFilter.filter(
                                      (s) => s !== "cancelled",
                                    )
                                  : [],
                              );
                            }
                          }}
                          className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t("appointments.date")}
            </label>
            <div className="flex items-center space-x-2">
              <input
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <button
                onClick={() => setDateFilter(today)}
                className="px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
              >
                {t("appointments.today")}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Appointments List or Calendar View */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">
            <div className="animate-spin w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full mx-auto"></div>
            <p className="mt-2">{t("appointments.loading_appointments")}</p>
          </div>
        ) : view === "list" ? (
          filteredAppointments.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <p>{t("appointments.no_appointments")}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full min-w-[920px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    {t("appointments.status")}
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    {t("appointments.client")}
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    {t("appointments.service")}
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    {t("appointments.professional")}
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    {t("appointments.date")} & {t("appointments.time")}
                  </th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    {t("appointments.price")}
                  </th>
                  <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    <span className="flex items-center justify-end">
                      <User className="w-4 h-4" />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {sortedAppointments.map((appointment) => (
                  <tr key={appointment.id} className={`hover:bg-gray-50 ${isCurrentTimeSlot(appointment) ? 'border-l-4 border-red-500' : ''}`}>
                    <td className="px-6 py-4">
                      {updatingId === appointment.id ? (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                          <div className="animate-spin w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full mr-1"></div>
                          {t("appointments.updating")}
                        </span>
                      ) : (
                        getStatusBadge(appointment.status as AppointmentStatus)
                      )}
                    </td>
                    <td className="px-6 py-4">
                        <div className="flex items-center">
                          <div className="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center flex-shrink-0">
                            <User className="w-5 h-5 text-indigo-600" />
                          </div>
                          <div className="ml-3 min-w-0">
                            <p className="font-medium text-gray-900 truncate max-w-[12rem]">
                              {getClientName(appointment.client)}
                            </p>
                          </div>
                        </div>
                      </td>
                    <td className="px-6 py-4 text-sm text-gray-900">
                      {getAllServiceNames(appointment).map((name, idx) => (
                        <div key={idx}>{name}</div>
                      ))}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {getAllProfessionalNames(appointment).map((name, idx) => (
                        <div key={idx}>{name}</div>
                      ))}
                    </td>
                     <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center text-sm text-gray-600">
                          <Calendar className="w-4 h-4 mr-1 text-gray-400" />
                          {appointment.scheduledDate.split("T")[0]}
                        </div>
                        <div className="flex items-center text-sm text-gray-600 mt-1">
                          <Clock className="w-4 h-4 mr-1 text-gray-400" />
                          {appointment.scheduledTime}
                        </div>
                      </td>
                    <td className="px-6 py-4 text-sm font-medium text-gray-900">
                      ${getTotalPrice(appointment)}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end space-x-2">
                        {appointment.status === "pending" && (
                          <button
                            onClick={() =>
                              updateStatus(appointment.id, "confirmed")
                            }
                            disabled={updatingId === appointment.id}
                            className="text-sm text-green-600 hover:text-green-700 disabled:opacity-50"
                            title={t("appointments.confirm")}
                          >
                            <CheckCircle className="w-5 h-5" />
                          </button>
                        )}
                        {appointment.status === "confirmed" && (
                          <button
                            onClick={() =>
                              updateStatus(appointment.id, "in_progress")
                            }
                            disabled={updatingId === appointment.id}
                            className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50"
                            title={t("appointments.start")}
                          >
                            <Clock className="w-5 h-5" />
                          </button>
                        )}
                        {appointment.status === "in_progress" && (
                          <button
                            onClick={() =>
                              updateStatus(appointment.id, "completed")
                            }
                            disabled={updatingId === appointment.id}
                            className="text-sm text-green-600 hover:text-green-700 disabled:opacity-50"
                            title={t("appointments.complete")}
                          >
                            <CheckCircle className="w-5 h-5" />
                          </button>
                        )}
                        {appointment.status !== "cancelled" &&
                          appointment.status !== "completed" && (
                            <button
                              onClick={() =>
                                updateStatus(appointment.id, "cancelled")
                              }
                              disabled={updatingId === appointment.id}
                              className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
                              title={t("appointments.cancel")}
                            >
                              <XCircle className="w-5 h-5" />
                            </button>
                          )}
                        <button
                          onClick={() => {
                            setSelectedAppointmentId(appointment.id);
                            setDrawerOpen(true);
                          }}
                          className="text-sm text-indigo-600 hover:text-indigo-700"
                          title={t("appointments.view")}
                        >
                          <Eye className="w-5 h-5" />
                        </button>
                      </div>
                     </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )
        ) : (
          // Calendar View using the new Calendar component
          <div className="p-6 h-[800px] min-w-0 overflow-x-auto overflow-y-hidden">
            <CalendarComponent
              tenantId="f6d06ea0-9bd8-490a-a704-e3bf95aad3ce"
              date={new Date(dateFilter)}
              onDateChange={(date) =>
                setDateFilter(date.toISOString().split("T")[0])
              }
              onAppointmentClick={(appointmentId) => {
                setSelectedAppointmentId(appointmentId);
                setDrawerOpen(true);
              }}
              onAppointmentUpdated={() => {
                fetchAppointments();
                setDrawerRefreshKey((prev) => prev + 1);
              }}
            />
          </div>
        )}
      </div>

      <AppointmentDrawer
        appointmentId={selectedAppointmentId}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        onAppointmentUpdated={fetchAppointments}
        refreshKey={drawerRefreshKey}
      />
    </div>
  );
}
