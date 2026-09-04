"use client";

import { useState, useEffect } from "react";
import { Calendar, Star, ChevronRight } from "lucide-react";
import apiClient from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { useTenantTranslations } from "@/lib/use-translation";
import { ChatWidget } from "@/src/components/virtual-receptionist";

interface UserData {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  role: string;
}

interface Appointment {
  id: string;
  serviceId: string;
  professionalId: string;
  scheduledDate: string;
  scheduledTime: string;
  duration: number;
  status:
    | "pending"
    | "confirmed"
    | "in_progress"
    | "completed"
    | "cancelled"
    | "no_show";
  price: number;
  currency: string;
}

interface Service {
  id: string;
  name: string;
  duration: number;
  price: number;
  category: string;
}

interface Professional {
  id: string;
  firstName: string;
  lastName: string;
}

export default function AccountPage({
  params,
}: {
  params: { salonName: string };
}) {
  const { toast } = useToast();
  const { t } = useTenantTranslations();
  const [loading, setLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserData | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [visiblePastAppointments, setVisiblePastAppointments] = useState(3);

  // Check if user is already logged in
  useEffect(() => {
    if (typeof window !== "undefined") {
      const userStr = localStorage.getItem("user");
      if (userStr) {
        const userData = JSON.parse(userStr);
        setCurrentUser(userData);
      }
    }
  }, [params.salonName]);

  // Fetch user data and appointments
  useEffect(() => {
    if (currentUser) {
      const fetchUserData = async () => {
        try {
          setLoading(true);
          // Fetch appointments by client ID
          const [appointmentsData, servicesData, professionalsData] =
            await Promise.all([
              apiClient.getAppointments({ clientId: currentUser.id }),
              apiClient.getServices(),
              apiClient.getProfessionals(),
            ]);

          setAppointments(appointmentsData);
          setServices(servicesData);
          setProfessionals(professionalsData);
        } catch (error) {
          console.error("Error fetching user data:", error);
          toast({
            title: "Error",
            description: "No se pudo cargar la información del usuario",
            variant: "destructive",
          });
        } finally {
          setLoading(false);
        }
      };

      fetchUserData();
    }
  }, [currentUser]);

  const handleCancelAppointment = async (
    appointmentId: string,
    reason?: string,
  ) => {
    try {
      await apiClient.cancelAppointment(appointmentId, reason);
      // Update the appointment status to cancelled instead of removing it
      setAppointments((prev) =>
        prev.map((apt) =>
          apt.id === appointmentId
            ? { ...apt, status: "cancelled" as const }
            : apt,
        ),
      );
      toast({
        title: "Cita cancelada",
        description: "Tu cita ha sido cancelada exitosamente",
      });
    } catch (error) {
      console.error("Error canceling appointment:", error);
      toast({
        title: "Error",
        description: "No se pudo cancelar la cita",
        variant: "destructive",
      });
    }
  };

  const handleRepeatAppointment = (appointment: Appointment) => {
    // Redirect to new-appointment page with pre-filled data
    window.location.href = `/${params.salonName}/account/new-appointment?serviceId=${appointment.serviceId}&professionalId=${appointment.professionalId}`;
  };

  const getServiceName = (serviceId: string) => {
    const service = services.find((s) => s.id === serviceId);
    return service ? service.name : "Servicio";
  };

  const getProfessionalName = (professionalId: string) => {
    const pro = professionals.find((p) => p.id === professionalId);
    return pro ? `${pro.firstName} ${pro.lastName}` : "Profesional";
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const options: Intl.DateTimeFormatOptions = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    };
    return date.toLocaleDateString("es-ES", options);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "pending":
        return "bg-yellow-100 text-yellow-800";
      case "confirmed":
        return "bg-green-100 text-green-800";
      case "in_progress":
        return "bg-blue-100 text-blue-800";
      case "completed":
        return "bg-gray-100 text-gray-800";
      case "cancelled":
        return "bg-red-100 text-red-800";
      case "no_show":
        return "bg-orange-100 text-orange-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case "pending":
        return "Pendiente";
      case "confirmed":
        return "Confirmada";
      case "in_progress":
        return "En curso";
      case "completed":
        return "Completada";
      case "cancelled":
        return "Cancelada";
      case "no_show":
        return "No asistió";
      default:
        return "Desconocido";
    }
  };

  if (!currentUser) {
    return null;
  }

  return (
    <>
      {/* Upcoming Appointments */}
      <div className="bg-white rounded-2xl shadow-lg p-8 mb-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-purple-900">Próximas Citas</h2>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full"></div>
          </div>
        ) : appointments.filter((apt) => {
            const isPastDate =
              new Date(apt.scheduledDate) <
              new Date(new Date().toISOString().split("T")[0]);
            return (
              (apt.status === "pending" || apt.status === "confirmed") &&
              !isPastDate
            );
          }).length > 0 ? (
          <div className="space-y-4">
            {appointments
              .filter((apt) => {
                const isPastDate =
                  new Date(apt.scheduledDate) <
                  new Date(new Date().toISOString().split("T")[0]);
                return (
                  (apt.status === "pending" || apt.status === "confirmed") &&
                  !isPastDate
                );
              })
              .sort(
                (a, b) =>
                  new Date(a.scheduledDate).getTime() -
                  new Date(b.scheduledDate).getTime(),
              )
              .map((appointment) => (
                <div
                  key={appointment.id}
                  className="border border-gray-200 rounded-lg p-4"
                >
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <div className="flex items-center space-x-2 mb-2">
                        <span
                          className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(appointment.status)}`}
                        >
                          {getStatusText(appointment.status)}
                        </span>
                      </div>
                      <h3 className="text-lg font-semibold text-gray-900 mb-1">
                        {getServiceName(appointment.serviceId)}
                      </h3>
                      <p className="text-sm text-gray-600 mb-1">
                        Con {getProfessionalName(appointment.professionalId)}
                      </p>
                      <p className="text-sm text-gray-600">
                        {formatDate(appointment.scheduledDate)} a las{" "}
                        {appointment.scheduledTime}
                      </p>
                    </div>
                  </div>

                  <div className="flex space-x-2">
                    <button
                      onClick={() => handleRepeatAppointment(appointment)}
                      className="flex items-center space-x-2 px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm"
                    >
                      <Star className="w-4 h-4" />
                      <span>Repetir</span>
                    </button>
                    <button
                      onClick={() => handleCancelAppointment(appointment.id)}
                      className="flex items-center space-x-2 px-3 py-1.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm"
                    >
                      <span>Cancelar</span>
                    </button>
                  </div>
                </div>
              ))}
          </div>
        ) : (
          <div className="text-center py-8">
            <Calendar className="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              No tienes citas próximas
            </h3>
            <p className="text-gray-600 mb-4">
              ¡Reserva tu próxima cita para disfrutar de nuestros servicios!
            </p>
            <a
              href={`/${params.salonName}`}
              className="inline-flex items-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
            >
              <span>Reservar Ahora</span>
              <ChevronRight className="w-4 h-4" />
            </a>
          </div>
        )}
      </div>

      {/* Past Appointments */}
      <div className="bg-white rounded-2xl shadow-lg p-8">
        <h2 className="text-2xl font-bold text-purple-900 mb-6">
          Historial de Citas
        </h2>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full"></div>
          </div>
        ) : appointments.filter((apt) => {
            const isPastDate =
              new Date(apt.scheduledDate) <
              new Date(new Date().toISOString().split("T")[0]);
            return (
              apt.status === "completed" ||
              apt.status === "cancelled" ||
              apt.status === "no_show" ||
              isPastDate
            );
          }).length > 0 ? (
          <div className="space-y-4">
            {appointments
              .filter((apt) => {
                const isPastDate =
                  new Date(apt.scheduledDate) <
                  new Date(new Date().toISOString().split("T")[0]);
                return (
                  apt.status === "completed" ||
                  apt.status === "cancelled" ||
                  apt.status === "no_show" ||
                  isPastDate
                );
              })
              .sort(
                (a, b) =>
                  new Date(b.scheduledDate).getTime() -
                  new Date(a.scheduledDate).getTime(),
              )
              .slice(0, visiblePastAppointments)
              .map((appointment) => (
                <div
                  key={appointment.id}
                  className="border border-gray-200 rounded-lg p-4"
                >
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <div className="flex items-center space-x-2 mb-2">
                        <span
                          className={`px-2 py-1 text-xs font-semibold rounded-full ${getStatusColor(appointment.status)}`}
                        >
                          {getStatusText(appointment.status)}
                        </span>
                      </div>
                      <h3 className="text-lg font-semibold text-gray-900 mb-1">
                        {getServiceName(appointment.serviceId)}
                      </h3>
                      <p className="text-sm text-gray-600 mb-1">
                        Con {getProfessionalName(appointment.professionalId)}
                      </p>
                      <p className="text-sm text-gray-600">
                        {formatDate(appointment.scheduledDate)} a las{" "}
                        {appointment.scheduledTime}
                      </p>
                    </div>
                  </div>

                  {appointment.status === "completed" && (
                    <div className="flex space-x-2">
                      <button
                        onClick={() => handleRepeatAppointment(appointment)}
                        className="flex items-center space-x-2 px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm"
                      >
                        <Star className="w-4 h-4" />
                        <span>Repetir</span>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            {/* Load more button */}
            {(() => {
              const pastAppointments = appointments.filter((apt) => {
                const isPastDate =
                  new Date(apt.scheduledDate) <
                  new Date(new Date().toISOString().split("T")[0]);
                return (
                  apt.status === "completed" ||
                  apt.status === "cancelled" ||
                  apt.status === "no_show" ||
                  isPastDate
                );
              });
              if (pastAppointments.length > visiblePastAppointments) {
                return (
                  <button
                    onClick={() =>
                      setVisiblePastAppointments((prev) => prev + 3)
                    }
                    className="w-full py-3 px-4 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm font-medium"
                  >
                    Cargar más citas (
                    {pastAppointments.length - visiblePastAppointments}{" "}
                    restantes)
                  </button>
                );
              }
              return null;
            })()}
          </div>
        ) : (
          <div className="text-center py-8">
            <Calendar className="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              No hay citas anteriores
            </h3>
            <p className="text-gray-600 mb-4">
              Tu historial de citas estará disponible aquí después de tu primera
              reserva.
            </p>
            <a
              href={`/${params.salonName}`}
              className="inline-flex items-center space-x-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
            >
              <span>Reservar Ahora</span>
              <ChevronRight className="w-4 h-4" />
            </a>
          </div>
        )}
      </div>

      {/* Virtual Receptionist Widget */}
      <ChatWidget
        salonId={params.salonName}
        clientId={currentUser.id}
        clientName={`${currentUser.firstName} ${currentUser.lastName}`}
        clientEmail={currentUser.email}
        clientPhone={currentUser.phone}
      />
    </>
  );
}
