"use client";

import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Calendar, Clock, User, CheckCircle } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import apiClient from "@/lib/api";
import { useTranslations, useTenantTranslations } from "@/lib/use-translation";

// Types for the widget
interface Salon {
  id: string;
  name: string;
  description?: string;
  address?: string;
  phone?: string;
  email?: string;
  isActive: boolean;
}

interface Service {
  id: string;
  name: string;
  description?: string;
  duration: number;
  price: number;
  currency: string;
  category: string;
  isActive: boolean;
}

interface Professional {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  specialties: string[];
  isActive: boolean;
}

interface Appointment {
  id: string;
  salonId: string;
  clientId: string;
  serviceId: string;
  professionalId: string;
  date: string;
  time: string;
  duration: number;
  price: number;
  status: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

interface ClientData {
  name: string;
  email: string;
  phone: string;
  language: "es" | "en";
}

interface BookingWidgetProps {
  salon: Salon;
  services: Service[];
  professionals: Professional[];
  className?: string;
  theme?: "light" | "dark";
  language?: "es" | "en";
  onBookingComplete: (appointment: Appointment) => void;
}

export const BookingWidget: React.FC<BookingWidgetProps> = ({
  salon,
  services,
  professionals,
  className = "",
  theme = "light",
  language = "es",
  onBookingComplete,
}) => {
  const { toast } = useToast();
  const [step, setStep] = useState<
    "service" | "professional" | "datetime" | "client" | "confirmation"
  >("service");
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [selectedProfessional, setSelectedProfessional] =
    useState<Professional | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [selectedTime, setSelectedTime] = useState<string>("");
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [clientData, setClientData] = useState<Partial<ClientData>>({
    name: "",
    email: "",
    phone: "",
    language: language,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [bookingComplete, setBookingComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const t = useTranslations();

  // Get available dates (next 30 days)
  const getAvailableDates = (): string[] => {
    const dates: string[] = [];
    const today = new Date();

    for (let i = 1; i <= 30; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);

      // Skip weekends (optional)
      if (date.getDay() !== 0) {
        dates.push(date.toISOString().split("T")[0]);
      }
    }

    return dates;
  };

  // Get available slots for a date and professional
  const getAvailableSlots = async (
    date: string,
    professionalId: string,
  ): Promise<string[]> => {
    try {
      const response = await apiClient.getAvailableSlots(
        salon.id,
        professionalId,
        selectedService?.id || "",
        date,
      );

      return response
        .filter((slot: { isAvailable: boolean }) => slot.isAvailable)
        .map((slot: { time: string }) => slot.time);
    } catch (error) {
      console.error("Error fetching available slots:", error);
      toast({
        title: "Error",
        description: t("noSlots"),
        variant: "destructive",
      });
      return [];
    }
  };

  useEffect(() => {
    if (selectedDate && selectedProfessional) {
      const loadSlots = async () => {
        const slots = await getAvailableSlots(
          selectedDate,
          selectedProfessional.id,
        );
        setAvailableSlots(slots);
      };
      loadSlots();
    }
  }, [selectedDate, selectedProfessional]);

  const handleServiceSelect = (serviceId: string) => {
    const service = services.find((s) => s.id === serviceId);
    if (service) {
      setSelectedService(service);
      setStep("professional");
    }
  };

  const handleProfessionalSelect = (professionalId: string) => {
    const professional = professionals.find((p) => p.id === professionalId);
    if (professional) {
      setSelectedProfessional(professional);
      setStep("datetime");
    }
  };

  const handleDateSelect = (date: string) => {
    setSelectedDate(date);
    setSelectedTime("");
  };

  const handleTimeSelect = (time: string) => {
    setSelectedTime(time);
    setStep("client");
  };

  const handleClientInfoChange = (field: keyof ClientData, value: string) => {
    setClientData((prev) => ({ ...prev, [field]: value }));
  };

  const validateStep = (currentStep: string): boolean => {
    switch (currentStep) {
      case "service":
        return !!selectedService;
      case "professional":
        return !!selectedProfessional;
      case "datetime":
        return !!selectedDate && !!selectedTime;
      case "client":
        return !!(clientData.name && clientData.email && clientData.phone);
      default:
        return true;
    }
  };

  const getValidationErrorMessage = (stepName: string): string => {
    switch (stepName) {
      case "service":
        return t("booking.select_service");
      case "professional":
        return t("booking.select_professional");
      case "datetime":
        if (!selectedDate) return t("booking.select_date");
        if (!selectedTime) return t("booking.select_time");
        break;
      case "client":
        return t("forms.field_required");
      default:
        return "";
    }
    return "";
  };

  const handleNext = () => {
    if (!validateStep(step)) {
      setError(getValidationErrorMessage(step));
      return;
    }

    switch (step) {
      case "service":
        setStep("professional");
        break;
      case "professional":
        setStep("datetime");
        break;
      case "datetime":
        setStep("client");
        break;
      case "client":
        handleBooking();
        break;
    }
  };

  const handleBooking = async () => {
    setIsLoading(true);

    try {
      // Simulate booking creation
      const appointment: Appointment = {
        id: `apt-${Date.now()}`,
        salonId: salon.id,
        clientId: `client-${Date.now()}`,
        serviceId: selectedService!.id,
        professionalId: selectedProfessional!.id,
        date: selectedDate,
        time: selectedTime,
        duration: selectedService!.duration,
        price: selectedService!.price,
        status: "confirmed",
        notes: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      setBookingComplete(true);
      onBookingComplete(appointment);

      console.log(
        `Appointment booked for ${clientData.name} on ${selectedDate} at ${selectedTime}`,
      );
    } catch (error) {
      setError("No se pudo procesar la reserva. Inténtalo de nuevo.");
    } finally {
      setIsLoading(false);
    }
  };

  const resetBooking = () => {
    setStep("service");
    setSelectedService(null);
    setSelectedProfessional(null);
    setSelectedDate("");
    setSelectedTime("");
    setClientData({
      name: "",
      email: "",
      phone: "",
      language: language,
    });
    setBookingComplete(false);
  };

  const renderServiceStep = () => (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">{t("selectService")}</h3>
      <div className="grid gap-3">
        {services.map((service) => (
          <Card
            key={service.id}
            className={`cursor-pointer transition-colors hover:bg-gray-50 ${selectedService?.id === service.id ? "ring-2 ring-blue-500" : ""}`}
            onClick={() => handleServiceSelect(service.id)}
          >
            <CardContent className="p-4">
              <div className="flex justify-between items-start">
                <div>
                  <h4 className="font-medium">{service.name}</h4>
                  <p className="text-sm text-gray-600">{service.description}</p>
                  <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                    <span className="flex items-center gap-1">
                      <Clock className="w-4 h-4" />
                      {service.duration} min
                    </span>
                    <span>{service.price}€</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );

  const getProfessionalName = (professional: Professional) => {
    return `${professional.firstName} ${professional.lastName}`;
  };

  const renderProfessionalStep = () => (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">
        {t("selectProfessional")}
      </h3>
      <div className="grid gap-3">
        {professionals.map((professional) => (
          <Card
            key={professional.id}
            className={`cursor-pointer transition-colors hover:bg-gray-50 ${selectedProfessional?.id === professional.id ? "ring-2 ring-blue-500" : ""}`}
            onClick={() => handleProfessionalSelect(professional.id)}
          >
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gray-200 rounded-full flex items-center justify-center">
                  <User className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-medium">
                    {getProfessionalName(professional)}
                  </h4>
                  <p className="text-sm text-gray-600">
                    {professional.specialties.join(", ")}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );

  const renderDateTimeStep = () => (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">
          {t("selectDate")}
        </h3>
        <div className="grid grid-cols-3 gap-2">
          {getAvailableDates()
            .slice(0, 9)
            .map((date) => (
              <Button
                key={date}
                variant={selectedDate === date ? "default" : "outline"}
                onClick={() => handleDateSelect(date)}
                className="p-2 h-auto flex flex-col"
              >
                <span className="text-xs">
                  {new Date(date).toLocaleDateString(
                    language === "es" ? "es-ES" : "en-US",
                    { weekday: "short" },
                  )}
                </span>
                <span className="font-medium">
                  {new Date(date).toLocaleDateString(
                    language === "es" ? "es-ES" : "en-US",
                    { day: "numeric" },
                  )}
                </span>
              </Button>
            ))}
        </div>
      </div>

      {selectedDate && (
        <div>
          <h3 className="text-lg font-semibold mb-4">
            {t("selectTime")}
          </h3>
          {availableSlots.length > 0 ? (
            <div className="grid grid-cols-4 gap-2">
              {availableSlots.map((time) => (
                <Button
                  key={time}
                  variant={selectedTime === time ? "default" : "outline"}
                  onClick={() => handleTimeSelect(time)}
                  className="p-2"
                >
                  {time}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-gray-500 text-center py-4">
              {t("noSlots")}
            </p>
          )}
        </div>
      )}
    </div>
  );

  const renderClientStep = () => (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">{t("clientInfo")}</h3>
      <div className="space-y-4">
        <div>
          <div className="text-sm font-medium mb-1">{t.name}</div>
          <Input
            id="name"
            value={clientData.name || ""}
            onChange={(e) => handleClientInfoChange("name", e.target.value)}
            placeholder="Tu nombre completo"
          />
        </div>
        <div>
          <div className="text-sm font-medium mb-1">{t("email")}</div>
          <Input
            id="email"
            type="email"
            value={clientData.email || ""}
            onChange={(e) => handleClientInfoChange("email", e.target.value)}
            placeholder="tu@email.com"
          />
        </div>
        <div>
          <div className="text-sm font-medium mb-1">{t("phone")}</div>
          <Input
            id="phone"
            value={clientData.phone || ""}
            onChange={(e) => handleClientInfoChange("phone", e.target.value)}
            placeholder="+34 600 000 000"
          />
        </div>
      </div>

      <div className="mt-6 p-4 bg-gray-50 rounded-lg">
        <h4 className="font-medium mb-2">Resumen de la cita:</h4>
        <div className="space-y-1 text-sm">
          <p>
            <strong>Servicio:</strong> {selectedService?.name}
          </p>
          <p>
            <strong>Profesional:</strong>{" "}
            {selectedProfessional
              ? getProfessionalName(selectedProfessional)
              : ""}
          </p>
          <p>
            <strong>Fecha:</strong>{" "}
            {selectedDate
              ? new Date(selectedDate).toLocaleDateString(
                  language === "es" ? "es-ES" : "en-US",
                )
              : ""}
          </p>
          <p>
            <strong>Hora:</strong> {selectedTime}
          </p>
          <p>
            <strong>Duración:</strong> {selectedService?.duration} minutos
          </p>
          <p>
            <strong>Precio:</strong> {selectedService?.price}€
          </p>
        </div>
      </div>
    </div>
  );

  const renderConfirmationStep = () => (
    <div className="text-center space-y-4">
      <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
        <CheckCircle className="w-8 h-8 text-green-600" />
      </div>
      <div>
        <h3 className="text-lg font-semibold">{t("success")}</h3>
        <p className="text-gray-600">
          Tu cita ha sido confirmada. Recibirás un email de confirmación en
          breve.
        </p>
      </div>
      <div className="mt-6 p-4 bg-gray-50 rounded-lg text-left">
        <h4 className="font-medium mb-2">Detalles de la cita:</h4>
        <div className="space-y-1 text-sm">
          <p>
            <strong>Servicio:</strong> {selectedService?.name}
          </p>
          <p>
            <strong>Profesional:</strong>{" "}
            {selectedProfessional
              ? getProfessionalName(selectedProfessional)
              : ""}
          </p>
          <p>
            <strong>Fecha:</strong>{" "}
            {selectedDate
              ? new Date(selectedDate).toLocaleDateString(
                  language === "es" ? "es-ES" : "en-US",
                )
              : ""}
          </p>
          <p>
            <strong>Hora:</strong> {selectedTime}
          </p>
          <p>
            <strong>Cliente:</strong> {clientData.name}
          </p>
        </div>
      </div>
      <Button onClick={resetBooking} className="w-full">
        Nueva Reserva
      </Button>
    </div>
  );

  return (
    <div
      className={`max-w-md mx-auto bg-white rounded-lg shadow-lg overflow-hidden ${className}`}
    >
      <div className="bg-gradient-to-r from-pink-500 to-purple-600 text-white p-6">
        <h2 className="text-xl font-bold">{salon.name}</h2>
        <p className="text-pink-100">{t("title")}</p>
      </div>

      <Card className="border-0 rounded-none">
        <CardContent className="p-6">
          {!bookingComplete ? (
            <>
              {/* Progress indicator */}
              <div className="flex items-center justify-between mb-6">
                {["service", "professional", "datetime", "client"].map(
                  (stepName, index) => (
                    <div key={stepName} className="flex items-center">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                          step === stepName
                            ? "bg-blue-500 text-white"
                            : [
                                  "service",
                                  "professional",
                                  "datetime",
                                  "client",
                                ].indexOf(step) > index
                              ? "bg-green-500 text-white"
                              : "bg-gray-200 text-gray-600"
                        }`}
                      >
                        {[
                          "service",
                          "professional",
                          "datetime",
                          "client",
                        ].indexOf(step) > index
                          ? "✓"
                          : index + 1}
                      </div>
                      {index < 3 && (
                        <div
                          className={`w-8 h-1 mx-2 ${
                            [
                              "service",
                              "professional",
                              "datetime",
                              "client",
                            ].indexOf(step) > index
                              ? "bg-green-500"
                              : "bg-gray-200"
                          }`}
                        />
                      )}
                    </div>
                  ),
                )}
              </div>

              {/* Step content */}
              {error && (
                <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-lg text-sm">
                  {error}
                </div>
              )}

              {step === "service" && renderServiceStep()}
              {step === "professional" && renderProfessionalStep()}
              {step === "datetime" && renderDateTimeStep()}
              {step === "client" && renderClientStep()}

              {/* Navigation buttons */}
              <div className="flex justify-between mt-6">
                <Button
                  variant="outline"
                  onClick={() => {
                    switch (step) {
                      case "professional":
                        setStep("service");
                        break;
                      case "datetime":
                        setStep("professional");
                        break;
                      case "client":
                        setStep("datetime");
                        break;
                    }
                  }}
                  disabled={step === "service"}
                >
                  {t("back")}
                </Button>

                <Button
                  onClick={handleNext}
                  disabled={isLoading || !validateStep(step)}
                >
                  {isLoading
                    ? t("loading")
                    : step === "client"
                      ? t("book")
                      : t("next")}
                </Button>
              </div>
            </>
          ) : (
            renderConfirmationStep()
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default BookingWidget;
