"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ImportLink } from "@/components/import-link";
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
  UserX,
} from "lucide-react";
import apiClient, { Appointment as ApiAppointment } from "../../../lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useToast } from "@/components/ui/use-toast";
import { Calendar as CalendarComponent } from "../../../components/Calendar/Calendar";
import { dateOfDay, localDay } from "../../../components/Calendar/day-grid";
import { AppointmentDrawer } from "./components/appointment-drawer";
import {
  appointmentTotalCents,
  drawerTargetFromQuery,
  asksFirst,
  formatCents,
  formatShortDay,
  sendStatusChange,
  serverMessage,
  statusActions,
  type AskedStatus,
} from "./components/appointment-drawer.utils";
import { StatusChangeDialog } from "./components/StatusChangeDialog";

type AppointmentStatus =
  | "confirmed"
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

/** The statuses the filter offers, in the order of a visit. */
const FILTER_STATUSES: AppointmentStatus[] = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
];

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

const getClientName = (client: Appointment["client"]) => {
  if (!client) return "—";
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
  if (!service) return "—";
  if (typeof service === "string") return service;
  return service.name;
};

// Get all service names for multi-service appointments
const getAllServiceNames = (appointment: Appointment) => {
  if (appointment.services && appointment.services.length > 0) {
    const names = appointment.services
      .map((s) => s.service?.name || "—")
      .filter(Boolean);
    if (names.length > 0) {
      return names;
    }
  }
  return [getServiceName(appointment.service)];
};

const getProfessionalName = (professional: Appointment["professional"]) => {
  if (!professional) return "—";
  if (typeof professional === "string") return professional;
  return `${professional.firstName} ${professional.lastName}`;
};

// Get all professional names for multi-service appointments
const getAllProfessionalNames = (appointment: Appointment) => {
  if (appointment.services && appointment.services.length > 0) {
    const names: string[] = [];
    appointment.services.forEach((s) => {
      if (s.professional) {
        names.push(`${s.professional.firstName} ${s.professional.lastName}`);
      }
    });
    if (names.length > 0) {
      return Array.from(new Set(names));
    }
  }
  return [getProfessionalName(appointment.professional)];
};

/** "35,00 €": the server's total (cents), else the services' prices (euros). */
const getTotalPrice = (appointment: Appointment) =>
  formatCents(appointmentTotalCents(appointment as any));

/** Whether an appointment falls in the month shown (its calendar day, not a UTC instant). */
const inMonth = (appointment: Appointment, month: Date) => {
  const day = dateOfDay(String(appointment.scheduledDate));
  return day.getMonth() === month.getMonth() && day.getFullYear() === month.getFullYear();
};

// Function to parse time string to minutes since midnight
const parseTimeToMinutes = (timeStr: string): number => {
  const [time, period] = timeStr.split(" ");
  const [hours, minutes] = time.split(":").map(Number);
  let totalMinutes = hours * 60 + minutes;
  if (period === "PM" && hours !== 12) totalMinutes += 12 * 60;
  if (period === "AM" && hours === 12) totalMinutes = minutes;
  return totalMinutes;
};

function AppointmentsPageContent() {
  const searchParams = useSearchParams();
  const t = useTranslations();
  const { toast } = useToast();
  // The browser's calendar day. toISOString() gave the UTC one: after
  // midnight in Madrid it was still yesterday, and in America, after the
  // evening, already tomorrow.
  const today = localDay();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<"list" | "calendar">("list");
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [professionalFilter, setProfessionalFilter] = useState("");
  const [serviceFilter, setServiceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus[]>([]);
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
  const [hasSearched, setHasSearched] = useState(false);

  // ?new=true opens the drawer for a new appointment; ?appointment=<id>
  // (&edit=1) opens an existing one -- the detail page's "Editar" lands here.
  const [drawerStartsInEdit, setDrawerStartsInEdit] = useState(false);
  useEffect(() => {
    const target = drawerTargetFromQuery(searchParams);
    if (!target) return;
    setSelectedAppointmentId(target.mode === "existing" ? target.appointmentId : null);
    setDrawerStartsInEdit(target.mode === "existing" && target.edit);
    setDrawerOpen(true);
  }, [searchParams]);

  const fetchAppointments = async () => {
    try {
      setLoadError(null);
      const data = await apiClient.getAppointments();
      setAppointments(data as unknown as Appointment[]);
    } catch (error) {
      // No invented diary. This used to show six fake appointments (Sarah
      // Johnson with John Smith, January 2026) with no warning, and a status
      // change on one of them then failed on its non-UUID id.
      console.error("Error fetching appointments:", error);
      setAppointments([]);
      setLoadError(serverMessage(error) ?? "");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAppointments();
  }, [view]);

  // Cancelling and a no-show tell the client, and completing is final and
  // may issue an invoice, so they are asked first (cancelling with an
  // optional reason).
  const [askingStatus, setAskingStatus] = useState<{
    id: string;
    to: AskedStatus;
  } | null>(null);

  const requestStatus = (id: string, newStatus: AppointmentStatus) => {
    if (asksFirst(newStatus)) {
      setAskingStatus({ id, to: newStatus });
    } else {
      void updateStatus(id, newStatus);
    }
  };

  const updateStatus = async (
    id: string,
    newStatus: AppointmentStatus,
    reason?: string,
  ) => {
    setUpdatingId(id);
    try {
      // Cancel, complete and no-show go to their own routes, which send the
      // notices, tell the wait-list and issue the invoice.
      await sendStatusChange(apiClient, id, newStatus, reason);
      setAppointments((prev) =>
        prev.map((apt) =>
          apt.id === id ? { ...apt, status: newStatus } : apt,
        ),
      );
    } catch (error) {
      console.error("Error updating appointment status:", error);
      // It used to fail in silence: the badge just did not change. The
      // description is the server's reason, e.g. "Una cita cancelada no
      // puede pasar a completada."
      toast({
        title: t("appointments.statusChangeFailed"),
        description: serverMessage(error),
        variant: "destructive",
      });
    } finally {
      setUpdatingId(null);
      setAskingStatus(null);
    }
  };

  const statusActionUi: Partial<
    Record<AppointmentStatus, { icon: React.ReactNode; className: string; label: string }>
  > = {
    confirmed: {
      icon: <CheckCircle className="w-5 h-5" />,
      className: "text-green-600 hover:text-green-700",
      label: t("appointments.confirm"),
    },
    in_progress: {
      icon: <Clock className="w-5 h-5" />,
      className: "text-blue-600 hover:text-blue-700",
      label: t("appointments.start"),
    },
    completed: {
      icon: <CheckCircle className="w-5 h-5" />,
      className: "text-green-600 hover:text-green-700",
      label: t("appointments.complete"),
    },
    no_show: {
      icon: <UserX className="w-5 h-5" />,
      className: "text-gray-600 hover:text-gray-700",
      label: t("appointments.no_show"),
    },
    cancelled: {
      icon: <XCircle className="w-5 h-5" />,
      className: "text-red-600 hover:text-red-700",
      label: t("appointments.cancel"),
    },
  };

  const statusLabel = (status: AppointmentStatus) => t(`appointments.status_${status}`);

  const getStatusBadge = (status: AppointmentStatus) => {
    const styles: Record<AppointmentStatus, string> = {
      confirmed: "bg-green-100 text-green-800",
      pending: "bg-yellow-100 text-yellow-800",
      in_progress: "bg-blue-100 text-blue-800",
      completed: "bg-purple-100 text-purple-800",
      cancelled: "bg-red-100 text-red-800",
      no_show: "bg-gray-100 text-gray-800",
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
        className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${styles[status] ?? "bg-gray-100 text-gray-800"}`}
      >
        {icons[status]}
        {statusLabel(status)}
      </span>
    );
  };

  /** "marzo de 2026". */
  const formatMonth = (date: Date) =>
    date.toLocaleDateString("es-ES", { month: "long", year: "numeric" });

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

  // Client search for the list view: name, email or phone, in the month shown.
  const handleClientSearch = () => {
    if (!clientSearchTerm.trim()) {
      setClientSearchResults([]);
      setHasSearched(false);
      return;
    }

    setHasSearched(true);
    const term = clientSearchTerm.toLowerCase();
    const results = appointments.filter((apt) => {
      const matchesSearch =
        getClientName(apt.client).toLowerCase().includes(term) ||
        getClientEmail(apt.client).toLowerCase().includes(term) ||
        getClientPhone(apt.client).toLowerCase().includes(term);
      return matchesSearch && inMonth(apt, currentDate);
    });

    setClientSearchResults(results);
  };

  // Extract unique professionals and services for dropdowns
  const uniqueProfessionals = Array.from(
    new Set(appointments.flatMap((apt) => getAllProfessionalNames(apt))),
  ).sort();

  const uniqueServices = Array.from(
    new Set(appointments.flatMap((apt) => getAllServiceNames(apt))),
  ).sort();

  // The row of an appointment happening now: only today's, at this hour.
  const isCurrentTimeSlot = (appointment: Appointment): boolean => {
    if (String(appointment.scheduledDate).slice(0, 10) !== today) return false;
    const appointmentHour = Math.floor(parseTimeToMinutes(appointment.scheduledTime) / 60);
    return appointmentHour === new Date().getHours();
  };

  const filteredAppointments = appointments.filter((apt) => {
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

    if (serviceFilter) {
      const serviceNames = getAllServiceNames(apt).map((n) => n.toLowerCase());
      if (
        !serviceNames.some((name) => name.includes(serviceFilter.toLowerCase()))
      ) {
        return false;
      }
    }

    if (statusFilter.length > 0 && !statusFilter.includes(apt.status as AppointmentStatus)) {
      return false;
    }

    // Date filter (only apply if dateFilter is set)
    if (dateFilter && dateFilter.trim() !== "") {
      if (String(apt.scheduledDate).split("T")[0] !== dateFilter) {
        return false;
      }
    }

    // Month filter (only while the client search is open)
    if (clientSearchOpen && !inMonth(apt, currentDate)) {
      return false;
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
    return parseTimeToMinutes(a.scheduledTime) - parseTimeToMinutes(b.scheduledTime);
  });

  const openAppointment = (id: string) => {
    setSelectedAppointmentId(id);
    setDrawerOpen(true);
  };

  /** The status buttons and "Ver" for a row or a card. */
  const renderActions = (appointment: Appointment, withStatus: boolean) => (
    <div className="flex items-center justify-end gap-2">
      {/* Only what the server's transition table allows: the next step,
          "No se presentó", "Cancelar". */}
      {withStatus &&
        statusActions(appointment.status).map((to) => {
          const ui = statusActionUi[to];
          if (!ui) return null;
          return (
            <button
              key={to}
              type="button"
              onClick={() => requestStatus(appointment.id, to)}
              disabled={updatingId === appointment.id}
              className={`p-1 text-sm ${ui.className} disabled:opacity-50`}
              title={ui.label}
              aria-label={ui.label}
            >
              {ui.icon}
            </button>
          );
        })}
      <button
        type="button"
        onClick={() => openAppointment(appointment.id)}
        className="p-1 text-sm text-indigo-600 hover:text-indigo-700"
        title={t("appointments.view_details")}
        aria-label={t("appointments.view_details")}
      >
        <Eye className="w-5 h-5" />
      </button>
    </div>
  );

  const renderStatus = (appointment: Appointment) =>
    updatingId === appointment.id ? (
      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
        <div className="animate-spin w-3 h-3 border-2 border-gray-500 border-t-transparent rounded-full mr-1"></div>
        {t("appointments.updating")}
      </span>
    ) : (
      getStatusBadge(appointment.status as AppointmentStatus)
    );

  /** Under md: one card per appointment instead of a 920px table. */
  const renderCards = (list: Appointment[], withStatus: boolean) => (
    <ul className="md:hidden divide-y divide-gray-200">
      {list.map((appointment) => (
        <li
          key={appointment.id}
          className={`p-4 ${isCurrentTimeSlot(appointment) ? "border-l-4 border-red-500" : ""}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium text-gray-900 truncate">{getClientName(appointment.client)}</p>
              <p className="text-sm text-gray-700 truncate">{getAllServiceNames(appointment).join(", ")}</p>
              <p className="text-sm text-gray-500 truncate">{getAllProfessionalNames(appointment).join(", ")}</p>
            </div>
            <div className="flex-shrink-0">{renderStatus(appointment)}</div>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
              <span className="inline-flex items-center">
                <Calendar className="w-4 h-4 mr-1 text-gray-400" />
                {formatShortDay(String(appointment.scheduledDate))}
              </span>
              <span className="inline-flex items-center">
                <Clock className="w-4 h-4 mr-1 text-gray-400" />
                {appointment.scheduledTime}
              </span>
              <span className="font-medium text-gray-900">{getTotalPrice(appointment)}</span>
            </div>
            {renderActions(appointment, withStatus)}
          </div>
        </li>
      ))}
    </ul>
  );

  /** From md: the table. */
  const renderTable = (list: Appointment[], withStatus: boolean, compact: boolean) => {
    const cell = compact ? "px-4 py-3" : "px-6 py-4";
    const head = `text-left ${compact ? "px-4 py-2" : "px-6 py-3"} text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap`;
    return (
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className={head}>{t("appointments.status")}</th>
              <th className={head}>{t("appointments.client")}</th>
              <th className={head}>{t("appointments.service")}</th>
              <th className={`${head} hidden lg:table-cell`}>{t("appointments.professional")}</th>
              <th className={head}>
                {t("appointments.date")} / {t("appointments.time")}
              </th>
              <th className={head}>{t("appointments.price")}</th>
              <th className={`${head} text-right`}>
                <span className="sr-only">{t("appointments.actions")}</span>
                <span className="flex items-center justify-end" aria-hidden="true">
                  <User className="w-4 h-4" />
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {list.map((appointment) => (
              <tr
                key={appointment.id}
                className={`hover:bg-gray-50 ${isCurrentTimeSlot(appointment) ? "border-l-4 border-red-500" : ""}`}
              >
                <td className={cell}>{renderStatus(appointment)}</td>
                <td className={cell}>
                  <div className="flex items-center">
                    <div className="w-8 h-8 lg:w-10 lg:h-10 bg-indigo-100 rounded-full flex items-center justify-center flex-shrink-0">
                      <User className="w-4 h-4 lg:w-5 lg:h-5 text-indigo-600" />
                    </div>
                    <div className="ml-3 min-w-0">
                      <p className="font-medium text-gray-900 truncate max-w-[12rem]">
                        {getClientName(appointment.client)}
                      </p>
                    </div>
                  </div>
                </td>
                <td className={`${cell} text-sm text-gray-900`}>
                  {getAllServiceNames(appointment).map((name, idx) => (
                    <div key={idx}>{name}</div>
                  ))}
                </td>
                <td className={`${cell} text-sm text-gray-600 hidden lg:table-cell`}>
                  {getAllProfessionalNames(appointment).map((name, idx) => (
                    <div key={idx}>{name}</div>
                  ))}
                </td>
                <td className={`${cell} whitespace-nowrap`}>
                  <div className="flex items-center text-sm text-gray-600">
                    <Calendar className="w-4 h-4 mr-1 text-gray-400" />
                    {formatShortDay(String(appointment.scheduledDate))}
                  </div>
                  <div className="flex items-center text-sm text-gray-600 mt-1">
                    <Clock className="w-4 h-4 mr-1 text-gray-400" />
                    {appointment.scheduledTime}
                  </div>
                </td>
                <td className={`${cell} text-sm font-medium text-gray-900 whitespace-nowrap`}>
                  {getTotalPrice(appointment)}
                </td>
                <td className={`${cell} text-right`}>{renderActions(appointment, withStatus)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {loadError !== null && (
        <div className="bg-red-50 text-red-600 p-4 rounded-lg">
          {t("appointments.load_failed")}
          {loadError ? `: ${loadError}` : ""}
        </div>
      )}
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
              type="button"
              onClick={() => setView("list")}
              aria-pressed={view === "list"}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                view === "list"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {t("appointments.list")}
            </button>
            <button
              type="button"
              onClick={() => setView("calendar")}
              aria-pressed={view === "calendar"}
              className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${
                view === "calendar"
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              {t("appointments.calendar")}
            </button>
          </div>
          <ImportLink kind="appointments" />
          <button
            type="button"
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

      {/* Find a client's appointments in a month */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <button
          type="button"
          onClick={() => setClientSearchOpen(!clientSearchOpen)}
          aria-expanded={clientSearchOpen}
          className="w-full flex items-center justify-between py-2 hover:bg-gray-50 transition-colors rounded-lg px-2 text-left"
        >
          <div className="flex flex-wrap items-center">
            <Search className="w-5 h-5 text-gray-500 mr-2" />
            <span className="font-medium text-gray-700">
              {t("appointments.find_client_appointment")}
            </span>
            <span className="ml-2 text-sm text-gray-500">
              {t("appointments.search_by_name_email_phone")}
            </span>
          </div>
          <ChevronDown
            className={`w-5 h-5 text-gray-500 transition-transform flex-shrink-0 ${clientSearchOpen ? "rotate-180" : ""}`}
          />
        </button>

        {clientSearchOpen && (
          <div className="mt-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:space-x-4">
              {/* Month Selector */}
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => navigateMonth("prev")}
                  className="p-2 hover:bg-gray-100 rounded-lg"
                  aria-label={t("appointments.previous_month")}
                  title={t("appointments.previous_month")}
                >
                  <ChevronLeft className="w-5 h-5 text-gray-600" />
                </button>
                <div className="flex items-center">
                  <Calendar className="w-5 h-5 text-gray-400 mr-2" />
                  <span className="font-semibold text-gray-900 first-letter:uppercase">
                    {formatMonth(currentDate)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => navigateMonth("next")}
                  className="p-2 hover:bg-gray-100 rounded-lg"
                  aria-label={t("appointments.next_month")}
                  title={t("appointments.next_month")}
                >
                  <ChevronRight className="w-5 h-5 text-gray-600" />
                </button>
              </div>

              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  aria-label={t("appointments.enter_name_email_phone")}
                  placeholder={t("appointments.enter_name_email_phone")}
                  value={clientSearchTerm}
                  onChange={(e) => setClientSearchTerm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleClientSearch();
                  }}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
              </div>

              <button
                type="button"
                onClick={handleClientSearch}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50"
              >
                {t("appointments.search")}
              </button>
            </div>

            {clientSearchResults.length > 0 && (
              <div className="mt-4">
                <p className="text-sm font-medium text-gray-700 mb-2">
                  {t("appointments.found_appointments_for", {
                    count: clientSearchResults.length,
                    date: formatMonth(currentDate),
                  })}
                </p>
                <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                  {renderCards(clientSearchResults, false)}
                  {renderTable(clientSearchResults, false, true)}
                </div>
              </div>
            )}

            {hasSearched &&
              clientSearchTerm &&
              clientSearchResults.length === 0 && (
                <div className="mt-4 p-4 bg-yellow-50 rounded-lg">
                  <p className="text-sm text-yellow-800">
                    {t("appointments.no_appointments_found", {
                      term: clientSearchTerm,
                      date: formatMonth(currentDate),
                    })}
                  </p>
                </div>
              )}
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="filter-professional" className="block text-sm font-medium text-gray-700 mb-1">
              {t("appointments.professional")}
            </label>
            <select
              id="filter-professional"
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
            <label htmlFor="filter-service" className="block text-sm font-medium text-gray-700 mb-1">
              {t("appointments.service")}
            </label>
            <select
              id="filter-service"
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
            <span className="block text-sm font-medium text-gray-700 mb-1">
              {t("appointments.status")}
            </span>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowStatusDropdown(!showStatusDropdown)}
                aria-expanded={showStatusDropdown}
                className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent flex items-center justify-between ${
                  statusFilter.length > 0 ? "bg-blue-50" : ""
                }`}
              >
                <span className="text-sm text-gray-700 truncate">
                  {statusFilter.length === 0
                    ? t("appointments.all_statuses")
                    : statusFilter.map(statusLabel).join(", ")}
                </span>
                <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
              </button>
              {showStatusDropdown && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg">
                  <label className="flex items-center justify-between p-2 cursor-pointer">
                    <span className="text-sm font-medium text-gray-700">
                      {t("appointments.all_statuses")}
                    </span>
                    <input
                      type="checkbox"
                      checked={statusFilter.length === 0}
                      onChange={(e) => {
                        if (e.target.checked) setStatusFilter([]);
                      }}
                      className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                    />
                  </label>
                  {FILTER_STATUSES.map((status) => (
                    <label
                      key={status}
                      className="flex items-center justify-between p-2 border-t border-gray-200 cursor-pointer"
                    >
                      <span className="text-sm text-gray-700">{statusLabel(status)}</span>
                      <input
                        type="checkbox"
                        value={status}
                        checked={statusFilter.includes(status)}
                        onChange={(e) =>
                          setStatusFilter((prev) =>
                            e.target.checked ? [...prev, status] : prev.filter((s) => s !== status),
                          )
                        }
                        className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div>
            <label htmlFor="filter-date" className="block text-sm font-medium text-gray-700 mb-1">
              {t("appointments.date")}
            </label>
            <div className="flex items-center space-x-2">
              <input
                id="filter-date"
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => setDateFilter(localDay())}
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
          sortedAppointments.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <p>{t("appointments.no_appointments")}</p>
            </div>
          ) : (
            <>
              {renderCards(sortedAppointments, true)}
              {renderTable(sortedAppointments, true, false)}
            </>
          )
        ) : (
          // Calendar View using the new Calendar component
          <div className="p-6 h-[800px] min-w-0 overflow-x-auto overflow-y-hidden">
            <CalendarComponent
              day={dateFilter}
              onDayChange={setDateFilter}
              onAppointmentClick={openAppointment}
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
        onOpenChange={(open) => {
          setDrawerOpen(open);
          if (!open) setDrawerStartsInEdit(false);
        }}
        onAppointmentUpdated={fetchAppointments}
        refreshKey={drawerRefreshKey}
        startInEditMode={drawerStartsInEdit}
      />

      <StatusChangeDialog
        to={askingStatus?.to ?? null}
        loading={!!askingStatus && updatingId === askingStatus.id}
        onCancel={() => setAskingStatus(null)}
        onConfirm={(reason) => {
          if (askingStatus) void updateStatus(askingStatus.id, askingStatus.to, reason);
        }}
      />
    </div>
  );
}

// useSearchParams() needs a Suspense boundary for the page to prerender
// (required since Next.js 14.1; 14.0 let it through).
export default function AppointmentsPage() {
  return (
    <Suspense fallback={null}>
      <AppointmentsPageContent />
    </Suspense>
  );
}
