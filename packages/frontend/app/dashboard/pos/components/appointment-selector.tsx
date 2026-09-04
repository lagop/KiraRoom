"use client";

import { useState, useEffect } from "react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

interface Appointment {
  id: string;
  scheduledDate: string;
  scheduledTime: string;
  status: string;
  paymentStatus: string;
  totalAmount: number;
  amountPaid: number;
  amountDue: number;
  depositRequired: boolean;
  depositAmount: number | null;
  depositPaid: boolean;
  client: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
  professional: {
    id: string;
    firstName: string;
    lastName: string;
  };
  service: {
    id: string;
    name: string;
    price: number;
    duration: number;
  };
  payments: Array<{
    id: string;
    amount: number;
    status: string;
    type: string;
    isDeposit: boolean;
    createdAt: string;
  }>;
}

interface AppointmentSelectorProps {
  onSelectAppointments: (appointments: Appointment[]) => void;
  onClose: () => void;
}

export default function AppointmentSelector({
  onSelectAppointments,
  onClose,
}: AppointmentSelectorProps) {
  const t = useTranslations();
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [dateFilter, setDateFilter] = useState<"all" | "today" | "tomorrow" | "week" | "last_week">("all");
  const [selectedAppointments, setSelectedAppointments] = useState<Appointment[]>([]);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadAppointments();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, dateFilter]);

  const loadAppointments = async () => {
    try {
      setLoading(true);
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

      let dateFrom: string | undefined;
      let dateTo: string | undefined;

      switch (dateFilter) {
        case "today":
          dateFrom = todayStart.toISOString();
          dateTo = todayEnd.toISOString();
          break;
        case "tomorrow":
          const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
          const tomorrowEnd = new Date(todayEnd.getTime() + 24 * 60 * 60 * 1000);
          dateFrom = tomorrowStart.toISOString();
          dateTo = tomorrowEnd.toISOString();
          break;
        case "week":
          dateFrom = todayStart.toISOString();
          const dayOfWeek = todayStart.getDay();
          const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
          const weekEndDate = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() + daysUntilSunday, 23, 59, 59, 999);
          dateTo = weekEndDate.toISOString();
          break;
        case "last_week":
          const lastWeekStart = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
          const yesterdayEnd = new Date(todayStart.getTime() - 1);
          yesterdayEnd.setHours(23, 59, 59, 999);
          dateFrom = lastWeekStart.toISOString();
          dateTo = yesterdayEnd.toISOString();
          break;
        default:
          // "all" - no date filtering
          break;
      }

      const data = await apiClient.getAppointments({
        searchQuery: searchQuery || undefined,
        startDate: dateFrom,
        endDate: dateTo,
      });

      // Filter appointments that need payment
      const pendingPayment = (data as any[]).filter(
        (apt) =>
          apt.paymentStatus !== "paid" &&
          apt.status !== "cancelled"
      );

      setAppointments(pendingPayment);
    } catch (error) {
      console.error("Failed to load appointments:", error);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("es-ES", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const formatTime = (timeString: string) => {
    return timeString;
  };

  const getPaymentStatusBadge = (appointment: Appointment) => {
    const isPaid = appointment.paymentStatus === "paid";
    const hasDeposit = appointment.depositPaid;
    const hasRemaining = appointment.amountDue > 0;

    if (isPaid) {
      return (
        <span className="px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
          {t("payments.status_paid")}
        </span>
      );
    }

    if (hasDeposit && hasRemaining) {
      return (
        <span className="px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800">
          {t("pos.partial")} - {formatCurrency(appointment.amountDue)} {t("pos.remaining")}
        </span>
      );
    }

    if (appointment.depositRequired && !appointment.depositPaid) {
      return (
        <span className="px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800">
          {t("pos.deposit_required")} - {formatCurrency(appointment.depositAmount || 0)}
        </span>
      );
    }

    return (
      <span className="px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-800">
        {t("payments.status_pending")}
      </span>
    );
  };

  const formatCurrency = (amount: number) => {
    // Amount from API is already in cents, convert to dollars for display
    return new Intl.NumberFormat("en-EU", {
      style: "currency",
      currency: "EUR",
    }).format(amount / 100);
  };

  const toggleSelection = (appointment: Appointment) => {
    setSelectedAppointments((prev) => {
      const exists = prev.find((a) => a.id === appointment.id);
      if (exists) {
        return prev.filter((a) => a.id !== appointment.id);
      }
      return [...prev, appointment];
    });
  };

  const handleConfirm = () => {
    if (selectedAppointments.length > 0) {
      onSelectAppointments(selectedAppointments);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-[600px] flex flex-col overflow-hidden">
        <div className="p-4 border-b flex justify-between items-center">
          <h2 className="text-lg font-semibold">{t("pos.select_appointment")}</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4 border-b">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("pos.search")}
              </label>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("pos.search_by_client")}
                className="w-full px-3 py-2 border rounded-lg"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("pos.date_filter")}
              </label>
              <select
                value={dateFilter}
                onChange={(e: any) => setDateFilter(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg"
              >
                <option value="all">{t("pos.all_dates")}</option>
                <option value="today">{t("pos.today")}</option>
                <option value="tomorrow">{t("pos.tomorrow")}</option>
                <option value="week">{t("pos.this_week")}</option>
                <option value="last_week">{t("pos.last_week")}</option>
              </select>
            </div>
          </div>
        </div>

         <div className="overflow-y-auto flex-1 p-4">
          {loading ? (
            <div className="text-center py-8 text-gray-500">{t("pos.loading")}</div>
          ) : appointments.length === 0 ? (
            <div className="text-center py-8 text-gray-500">{t("pos.no_appointments_found")}</div>
          ) : (
             <div className="space-y-3">
               {appointments.map((appointment) => {
                 const isSelected = selectedAppointments.some((a) => a.id === appointment.id);
                 return (
                   <div
                     key={appointment.id}
                     onClick={() => toggleSelection(appointment)}
                     className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                       isSelected
                         ? "border-blue-500 bg-blue-50 ring-1 ring-blue-300"
                         : "hover:border-blue-300 hover:bg-gray-50"
                     }`}
                   >
                     <div className="flex items-start gap-3">
                       <div className="pt-0.5">
                         <input
                           type="checkbox"
                           checked={isSelected}
                           onChange={() => toggleSelection(appointment)}
                           onClick={(e) => e.stopPropagation()}
                           className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                         />
                       </div>
                       <div className="flex-1 min-w-0">
                         <div className="flex justify-between items-start mb-2">
                           <div>
                             <div className="font-medium">
                               {appointment.client.firstName} {appointment.client.lastName}
                             </div>
                             <div className="text-sm text-gray-500">
                               {appointment.service.name}
                             </div>
                           </div>
                           {getPaymentStatusBadge(appointment)}
                         </div>
                         <div className="grid grid-cols-3 gap-2 text-sm text-gray-600">
                           <div>
                             <span className="font-medium">{t("pos.date")}:</span>{" "}
                             {formatDate(appointment.scheduledDate)}
                           </div>
                           <div>
                             <span className="font-medium">{t("pos.time")}:</span>{" "}
                             {formatTime(appointment.scheduledTime)}
                           </div>
                           <div>
                             <span className="font-medium">{t("pos.professional")}:</span>{" "}
                             {appointment.professional.firstName} {appointment.professional.lastName}
                           </div>
                         </div>
                         <div className="mt-2 flex justify-between items-center">
                           <div className="text-sm">
                             <span className="font-medium">{t("pos.total")}:</span>{" "}
                             {formatCurrency(appointment.totalAmount)}
                           </div>
                         </div>
                         {appointment.depositPaid && (
                           <div className="text-sm text-green-600 mt-1">
                             <span className="font-medium">{t("pos.deposit_paid")}:</span>{" "}
                             {formatCurrency(appointment.depositAmount || 0)}
                           </div>
                         )}
                       </div>
                     </div>
                   </div>
                 );
               })}
             </div>
          )}
        </div>

        <div className="p-4 border-t">
          {selectedAppointments.length > 0 && (
            <div className="mb-3 p-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
              {selectedAppointments.length} {selectedAppointments.length === 1 ? t("pos.appointment_selected").toLowerCase() : t("pos.appointments_selected")} —{" "}
              {formatCurrency(selectedAppointments.reduce((sum, a) => sum + a.totalAmount, 0))} {t("pos.total").toLowerCase()}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 border rounded-lg hover:bg-gray-100"
            >
              {t("pos.cancel")}
            </button>
            <button
              onClick={handleConfirm}
              disabled={selectedAppointments.length === 0}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
            >
              {t("pos.select")} {selectedAppointments.length > 0 && `(${selectedAppointments.length})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
