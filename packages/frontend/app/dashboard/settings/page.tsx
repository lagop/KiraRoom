"use client";

import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Settings,
  Store,
  Globe,
  Bell,
  Calendar,
  CreditCard,
  BarChart3,
  Palette,
  Users,
  Lock,
  Clock,
  ChevronRight,
  Check,
  ShieldAlert,
} from "lucide-react";
import { StripeSettingsContent } from "./stripe-settings-content";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

const defaultSettingsData = {
  general: [
    {
      id: "businessName",
      label: "Nombre del salón/negocio",
      type: "text",
      value: "Kira Studio",
      description:
        "El nombre que se muestra en el dashboard y en la interfaz de usuario",
    },
    {
      id: "address",
      label: "Dirección del salón",
      type: "text",
      value: "Calle Principal 123, Local 4",
      description: "Ubicación visible en el perfil y en la página de contacto",
    },
    {
      id: "contactPhone",
      label: "Teléfono",
      type: "text",
      value: "+34 123 456 789",
      description: "Número de contacto principal",
    },
    {
      id: "contactEmail",
      label: "Correo electrónico",
      type: "email",
      value: "info@kirastudio.com",
      description: "Correo electrónico de contacto",
    },
    {
      id: "instagram",
      label: "Instagram",
      type: "text",
      value: "@kirastudio_official",
      description: "Perfil de Instagram",
    },
    {
      id: "facebook",
      label: "Facebook",
      type: "text",
      value: "KiraStudioOfficial",
      description: "Página de Facebook",
    },
    {
      id: "openingTime",
      label: "Horario de apertura",
      type: "time",
      value: "09:00",
      description: "Hora de apertura del salón",
    },
    {
      id: "closingTime",
      label: "Horario de cierre",
      type: "time",
      value: "20:00",
      description: "Hora de cierre del salón",
    },
    {
      id: "workingDays",
      label: "Días laborables",
      type: "checkbox-group",
      value: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ],
      options: [
        { id: "monday", label: "Lunes" },
        { id: "tuesday", label: "Martes" },
        { id: "wednesday", label: "Miércoles" },
        { id: "thursday", label: "Jueves" },
        { id: "friday", label: "Viernes" },
        { id: "saturday", label: "Sábado" },
        { id: "sunday", label: "Domingo" },
      ],
      description: "Días de la semana en que el salón está abierto",
    },
  ],
  preferences: [
    {
      id: "language",
      label: "Idioma",
      type: "select",
      value: "es",
      options: [
        { id: "es", label: "Español" },
        { id: "en", label: "English" },
      ],
      description: "Idioma principal de la interfaz",
    },
    {
      id: "currency",
      label: "Moneda",
      type: "select",
      value: "EUR",
      options: [
        { id: "EUR", label: "Euro (€)" },
        { id: "USD", label: "Dólar (USD)" },
        { id: "GBP", label: "Libra (GBP)" },
        { id: "JPY", label: "Yen (JPY)" },
      ],
      description: "Moneda utilizada en las transacciones",
    },
    {
      id: "dateFormat",
      label: "Formato de fecha",
      type: "select",
      value: "dd/mm/yyyy",
      options: [
        { id: "dd/mm/yyyy", label: "DD/MM/YYYY" },
        { id: "mm/dd/yyyy", label: "MM/DD/YYYY" },
        { id: "yyyy/mm/dd", label: "YYYY/MM/DD" },
      ],
      description: "Formato de visualización de fechas",
    },
    {
      id: "timeFormat",
      label: "Formato de hora",
      type: "select",
      value: "24",
      options: [
        { id: "24", label: "24 horas" },
        { id: "12", label: "12 horas" },
      ],
      description: "Formato de visualización de horas",
    },
    {
      id: "notifications",
      label: "Notificaciones",
      type: "checkbox-group",
      value: ["email", "sms", "push"],
      options: [
        { id: "email", label: "Email" },
        { id: "sms", label: "SMS" },
        { id: "push", label: "Push notifications" },
      ],
      description: "Preferencias de notificación",
    },
  ],
  services: [
    {
      id: "minAppointmentDuration",
      label: "Duración mínima de citas",
      type: "number",
      value: "30",
      description: "Duración mínima de las citas en minutos",
    },
    {
      id: "appointmentInterval",
      label: "Intervalo entre citas",
      type: "number",
      value: "15",
      description: "Tiempo de espera entre citas en minutos",
    },
    {
      id: "cancellationPolicy",
      label: "Tiempo máximo para cancelar",
      type: "select",
      value: "24",
      options: [
        { id: "0", label: "Sin política" },
        { id: "2", label: "2 horas" },
        { id: "6", label: "6 horas" },
        { id: "12", label: "12 horas" },
        { id: "24", label: "24 horas" },
        { id: "48", label: "48 horas" },
      ],
      description: "Tiempo máximo para cancelar una cita sin cargo",
    },
    {
      id: "cancellationFee",
      label: "Cargo por cancelación",
      type: "number",
      value: "20",
      description: "Porcentaje de cargo por cancelación tardía",
    },
    {
      id: "autoConfirm",
      label: "Confirmación automática",
      type: "switch",
      value: "true",
      description: "Las citas se confirman automáticamente",
    },
  ],
  payments: [
    {
      id: "paymentMethods",
      label: "Métodos de pago aceptados",
      type: "checkbox-group",
      value: ["credit-card", "cash", "transfer"],
      options: [
        { id: "credit-card", label: "Tarjeta de crédito" },
        { id: "debit-card", label: "Tarjeta de débito" },
        { id: "cash", label: "Efectivo" },
        { id: "transfer", label: "Transferencia bancaria" },
        { id: "paypal", label: "PayPal" },
      ],
      description: "Métodos de pago que acepta el salón",
    },
    {
      id: "urgencyFee",
      label: "Tarifa de urgencia",
      type: "number",
      value: "25",
      description: "Porcentaje adicional por servicios urgentes",
    },
    {
      id: "specialServiceFee",
      label: "Servicios especiales",
      type: "number",
      value: "15",
      description: "Porcentaje adicional por servicios especiales",
    },
    {
      id: "taxRate",
      label: "Tasa de impuestos",
      type: "number",
      value: "21",
      description: "Tasa de impuestos aplicada a los servicios",
    },
  ],
  users: [
    {
      id: "userRoles",
      label: "Roles de usuario",
      type: "checkbox-group",
      value: ["admin", "professional", "receptionist"],
      options: [
        { id: "admin", label: "Administrador" },
        { id: "professional", label: "Profesional" },
        { id: "receptionist", label: "Recepcionista" },
        { id: "client", label: "Cliente" },
      ],
      description: "Roles y permisos de los usuarios",
    },
    {
      id: "allowProfessionalCrossBooking",
      label: "Permitir que profesionales creen citas para otros",
      type: "switch",
      value: "false",
      description:
        "Los profesionales pueden crear citas para cualquier profesional activo. Si está desactivado, solo pueden crear citas para sí mismos.",
      adminOnly: true, // Custom flag to show only to owner/admin
    },
    {
      id: "sessionTimeout",
      label: "Tiempo de expiración de sesión",
      type: "select",
      value: "30",
      options: [
        { id: "15", label: "15 minutos" },
        { id: "30", label: "30 minutos" },
        { id: "60", label: "60 minutos" },
        { id: "120", label: "2 horas" },
        { id: "0", label: "Nunca" },
      ],
      description: "Tiempo de inactividad antes de cerrar la sesión",
    },
    {
      id: "passwordPolicy",
      label: "Política de contraseñas",
      type: "select",
      value: "strong",
      options: [
        { id: "simple", label: "Simple" },
        { id: "medium", label: "Medio" },
        { id: "strong", label: "Fuerte" },
      ],
      description: "Nivel de seguridad de las contraseñas",
    },
    {
      id: "activityHistory",
      label: "Historial de actividades",
      type: "switch",
      value: "true",
      description: "Registro de actividades de los usuarios",
    },
  ],
  analytics: [
    {
      id: "reportFrequency",
      label: "Frecuencia de reportes",
      type: "select",
      value: "weekly",
      options: [
        { id: "daily", label: "Diario" },
        { id: "weekly", label: "Semanal" },
        { id: "monthly", label: "Mensual" },
        { id: "quarterly", label: "Trimestral" },
        { id: "yearly", label: "Anual" },
      ],
      description: "Frecuencia de generación de reportes",
    },
    {
      id: "revenueGoal",
      label: "Meta de ingresos",
      type: "number",
      value: "5000",
      description: "Meta mensual de ingresos en €",
    },
    {
      id: "appointmentGoal",
      label: "Meta de citas",
      type: "number",
      value: "200",
      description: "Meta mensual de citas",
    },
    {
      id: "newClientsGoal",
      label: "Meta de clientes nuevos",
      type: "number",
      value: "50",
      description: "Meta mensual de clientes nuevos",
    },
    {
      id: "dashboardWidgets",
      label: "Widgets del dashboard",
      type: "checkbox-group",
      value: ["stats", "appointments", "revenue", "clients"],
      options: [
        { id: "stats", label: "Estadísticas generales" },
        { id: "appointments", label: "Citas recientes" },
        { id: "revenue", label: "Ingresos" },
        { id: "clients", label: "Clientes nuevos" },
        { id: "popular-services", label: "Servicios populares" },
      ],
      description: "Widgets visibles en el dashboard",
    },
  ],
  interface: [
    {
      id: "colorTheme",
      label: "Tema de color",
      type: "select",
      value: "purple",
      options: [
        { id: "purple", label: "Morado" },
        { id: "blue", label: "Azul" },
        { id: "green", label: "Verde" },
        { id: "pink", label: "Rosa" },
      ],
      description: "Tema de color de la interfaz",
    },
    {
      id: "logo",
      label: "Logo del salón",
      type: "file",
      value: "",
      description: "Logo que se muestra en la interfaz",
    },
    {
      id: "welcomeMessage",
      label: "Mensaje de bienvenida",
      type: "textarea",
      value: "¡Bienvenido a Kira Studio! Estamos emocionados de tenerte aquí.",
      description: "Mensaje mostrado al iniciar sesión",
    },
    {
      id: "appointmentConfirmMessage",
      label: "Mensaje de confirmación",
      type: "textarea",
      value: "Tu cita ha sido confirmada. Gracias por elegir Kira Studio!",
      description: "Mensaje de confirmación de cita",
    },
    {
      id: "appointmentReminderMessage",
      label: "Recordatorio de cita",
      type: "textarea",
      value:
        "Recordatorio: Tu cita es mañana a las [hora]. ¡No olvides presentarte 10 minutos antes!",
      description: "Mensaje de recordatorio de cita",
    },
  ],
};

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("general");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [settings, setSettings] = useState(() => {
    const initial: Record<string, any> = {};
    Object.values(defaultSettingsData)
      .flat()
      .forEach((field) => {
        initial[field.id] = field.value;
      });
    return initial;
  });
  const [tenantSettings, setTenantSettings] = useState<any>(null);
  const [professionalCrossBooking, setProfessionalCrossBooking] =
    useState<boolean>(false);
  const t = useTranslations();

  useEffect(() => {
    const loadTenantSettings = async () => {
      try {
        const tenant = await apiClient.getTenant();
        setTenantSettings(tenant);
        // Update settings with tenant values
        setSettings((prev) => ({
          ...prev,
          language: tenant.language,
          currency: tenant.currency,
          timezone: tenant.timezone,
        }));

        // Load professional cross-booking setting
        try {
          const crossBookingSetting =
            await apiClient.getProfessionalCrossBookingSetting();
          setProfessionalCrossBooking(
            crossBookingSetting.allowProfessionalCrossBooking,
          );
        } catch (error) {
          console.error(
            "Error loading professional cross-booking setting:",
            error,
          );
          // Default to false if API call fails
          setProfessionalCrossBooking(false);
        }
      } catch (error) {
        console.error("Error loading tenant settings:", error);
        // If authentication fails, redirect to login
        if (typeof window !== "undefined") {
          window.location.href = "/login";
        }
      }
    };

    loadTenantSettings();
  }, []);

  const handleFieldChange = (fieldId: string, value: any) => {
    setSettings((prev) => ({
      ...prev,
      [fieldId]: value,
    }));
    setSuccess(false);
  };

  const handleSubmit = async () => {
    setLoading(true);

    try {
      // Update tenant settings (language, currency, timezone)
      const tenantUpdateData: any = {};
      if (settings.language !== tenantSettings?.language) {
        tenantUpdateData.language = settings.language;
      }
      if (settings.currency !== tenantSettings?.currency) {
        tenantUpdateData.currency = settings.currency;
      }
      if (settings.timezone !== tenantSettings?.timezone) {
        tenantUpdateData.timezone = settings.timezone;
      }

      if (Object.keys(tenantUpdateData).length > 0) {
        await apiClient.updateTenant(tenantUpdateData);
        // Update local tenant settings
        setTenantSettings((prev: any) => ({ ...prev, ...tenantUpdateData }));
      }

      // Update professional cross-booking setting
      await apiClient.updateProfessionalCrossBookingSetting(
        professionalCrossBooking,
      );

      // TODO: Save other settings (business info, etc.) when backend endpoints are available

      console.log("Settings saved successfully");
      setSuccess(true);
    } catch (error) {
      console.error("Error updating settings:", error);
      // If authentication fails, redirect to login
      if (error instanceof Error && error.message.includes("401")) {
        if (typeof window !== "undefined") {
          window.location.href = "/login";
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const renderInput = (field: any) => {
    const isAdvanced = ["payments", "analytics", "interface"].includes(
      activeTab,
    );

    // Check if field is admin-only and user is not owner/admin
    // For now, we'll assume the user can access admin settings if they can see the settings page
    // In a real app, you'd check the user's role from authentication
    const isAdminOnly = field.adminOnly;
    const canAccessAdminSettings = true; // TODO: Check user role from auth context

    const baseClassName = `w-full ${isAdvanced ? "opacity-50 cursor-not-allowed" : ""}`;

    // Skip rendering admin-only fields if user doesn't have permission
    if (isAdminOnly && !canAccessAdminSettings) {
      return null;
    }

    switch (field.type) {
      case "text":
      case "email":
        return (
          <input
            type={field.type}
            value={settings[field.id]}
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
            disabled={isAdvanced}
            className={`px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors ${baseClassName}`}
          />
        );

      case "number":
        return (
          <input
            type="number"
            value={settings[field.id]}
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
            disabled={isAdvanced}
            className={`px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors ${baseClassName}`}
          />
        );

      case "time":
        return (
          <input
            type="time"
            value={settings[field.id]}
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
            disabled={isAdvanced}
            className={`px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors ${baseClassName}`}
          />
        );

      case "select":
        return (
          <select
            value={settings[field.id]}
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
            disabled={isAdvanced}
            className={`px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors ${baseClassName}`}
          >
            {field.options.map((option: any) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        );

      case "textarea":
        return (
          <textarea
            value={settings[field.id] ?? field.value}
            disabled={isAdvanced}
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
            rows={3}
            className={`px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors resize-none ${baseClassName}`}
          />
        );

      case "switch":
        // Special handling for professional cross-booking setting
        const isProfessionalCrossBooking =
          field.id === "allowProfessionalCrossBooking";
        const checked = isProfessionalCrossBooking
          ? professionalCrossBooking
          : settings[field.id] === "true";
        const onChange = isProfessionalCrossBooking
          ? (e: React.ChangeEvent<HTMLInputElement>) => {
              setProfessionalCrossBooking(e.target.checked);
              setSuccess(false);
            }
          : (e: React.ChangeEvent<HTMLInputElement>) =>
              handleFieldChange(field.id, e.target.checked ? "true" : "false");

        return (
          <label
            className={`relative inline-flex items-center cursor-pointer ${isAdvanced ? "cursor-not-allowed" : ""}`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={isAdvanced}
              onChange={onChange}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-purple-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
          </label>
        );

      case "checkbox-group":
        const currentValue = settings[field.id] ?? field.value;
        return (
          <div className="flex flex-wrap gap-2">
            {field.options.map((option: any) => (
              <label
                key={option.id}
                className={`flex items-center space-x-2 p-2 border rounded-lg cursor-pointer transition-colors ${
                  isAdvanced
                    ? "opacity-50 cursor-not-allowed bg-gray-50"
                    : "hover:bg-gray-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={currentValue.includes(option.id)}
                  disabled={isAdvanced}
                  onChange={(e) => {
                    const newValue = e.target.checked
                      ? [...currentValue, option.id]
                      : currentValue.filter((id: string) => id !== option.id);
                    handleFieldChange(field.id, newValue);
                  }}
                  className="w-4 h-4 text-purple-600 bg-gray-100 border-gray-300 rounded focus:ring-purple-500 focus:ring-2"
                />
                <span className="text-sm">{option.label}</span>
              </label>
            ))}
          </div>
        );

      case "file":
        return (
          <div
            className={`p-4 border-2 border-dashed border-gray-300 rounded-lg text-center ${
              isAdvanced
                ? "opacity-50 cursor-not-allowed"
                : "hover:border-purple-500 hover:bg-purple-50"
            }`}
          >
            <input
              type="file"
              disabled={isAdvanced}
              onChange={(e) =>
                handleFieldChange(field.id, e.target.files?.[0] || null)
              }
              className="hidden"
              accept="image/*"
            />
            <label
              className={`cursor-pointer ${isAdvanced ? "cursor-not-allowed" : ""}`}
            >
              <Palette className="mx-auto h-8 w-8 text-gray-400 mb-2" />
              <div className="text-sm font-medium text-gray-600">
                {settings[field.id] ? "Cambiar logo" : "Subir logo"}
              </div>
            </label>
          </div>
        );

      default:
        return null;
    }
  };

  const isAdvancedTab = ["analytics", "interface"].includes(activeTab);

  const tabConfig = [
    { id: "general", label: t("settings.general"), icon: Store },
    { id: "preferences", label: t("settings.preferences"), icon: Settings },
    { id: "services", label: t("settings.services"), icon: Calendar },
    { id: "payments", label: t("settings.payments"), icon: CreditCard },
    { id: "users", label: t("settings.users"), icon: Users },
    { id: "analytics", label: t("settings.analytics"), icon: BarChart3 },
    { id: "interface", label: t("settings.interface"), icon: Palette },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 truncate">
          {t("settings.title")}
        </h1>
        <p className="text-gray-500 mt-1">{t("settings.description")}</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {/* Tabs Navigation */}
        <div className="border-b border-gray-200">
          <nav className="flex flex-wrap gap-x-8 gap-y-2 px-6">
            {tabConfig.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`py-4 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 transition-colors ${
                    activeTab === tab.id
                      ? "border-purple-500 text-purple-600"
                      : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {isAdvancedTab && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg flex items-start space-x-3">
              <ShieldAlert className="w-5 h-5 text-yellow-600 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-medium text-yellow-800">
                  Funcionalidad Premium
                </h3>
                <p className="text-sm text-yellow-700 mt-1">
                  Esta sección estará disponible en el plan avanzado de
                  KiraStudio. Contacta a soporte para más información.
                </p>
              </div>
              <ChevronRight className="w-5 h-5 text-yellow-500" />
            </div>
          )}

          {activeTab === "payments" ? (
            <StripeSettingsContent />
          ) : (defaultSettingsData as any)[activeTab] ? (
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              {(defaultSettingsData as any)[activeTab].map((field: any) => (
                <div key={field.id} className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">
                    {field.label}
                  </label>
                  {field.description && (
                    <p className="text-xs text-gray-500">{field.description}</p>
                  )}
                  {renderInput(field)}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">
                No settings available for this tab.
              </p>
            </div>
          )}

          {!isAdvancedTab && (
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end sm:space-x-3 mt-8 pt-6 border-t border-gray-200">
              <button
                onClick={() => setSuccess(false)}
                className="px-6 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                {loading ? (
                  <>
                    <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                    <span>{t("common.saving")}</span>
                  </>
                ) : success ? (
                  <>
                    <Check className="w-4 h-4" />
                    <span>{t("settings.settings_updated")}</span>
                  </>
                ) : (
                  <span>{t("settings.save_changes")}</span>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

