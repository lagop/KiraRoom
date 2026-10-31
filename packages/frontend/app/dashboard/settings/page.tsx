"use client";

import { useState, useEffect } from "react";
import {
  Settings,
  Store,
  Calendar,
  CreditCard,
  Users,
  Check,
} from "lucide-react";
import { StripeSettingsContent } from "./stripe-settings-content";
import apiClient from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";
import { useTranslations } from "@/lib/use-translation";
import { SALON_TIMEZONES, type SalonAddress } from "@kira/shared";
import { CanaryTimezoneHint } from "@/components/settings/CanaryTimezoneHint";
import { SalonHoursField } from "@/components/settings/SalonHoursField";
import { salonHoursProblem } from "@/lib/salon-hours";
import {
  BOOKING_SLOT_OPTIONS,
  settingsFromTenant,
  tenantUpdateFrom,
} from "@/lib/general-settings";
import Link from "next/link";

/**
 * The fields of each tab. Every one is saved on the tenant
 * (lib/general-settings.ts), except the cross-booking switch, which has its
 * own endpoint. The page used to list many more -- fees, payment methods,
 * user roles, session and password policies, goals, themes, message texts --
 * that nothing saved or read; they were shown disabled under "Próximamente"
 * and are gone. Where the real setting lives on another page, the tab links
 * to it (TAB_LINKS).
 */
const defaultSettingsData = {
  general: [
    {
      id: "businessName",
      label: "Nombre del salón/negocio",
      type: "text",
      description:
        "El nombre que se muestra en el dashboard y en la interfaz de usuario",
    },
    {
      id: "address",
      label: "Dirección del salón",
      type: "text",
      description: "Ubicación visible en el perfil y en la página de contacto",
    },
    {
      id: "contactPhone",
      label: "Teléfono",
      type: "text",
      description: "Número de contacto principal",
    },
    {
      id: "contactEmail",
      label: "Correo electrónico",
      type: "email",
      description: "Correo electrónico de contacto",
    },
    {
      id: "instagram",
      label: "Instagram",
      type: "text",
      placeholder: "@tusalon",
      description:
        "Tu usuario (@tusalon) o el enlace a tu perfil. Aparece en tu página de reservas.",
    },
    {
      id: "facebook",
      label: "Facebook",
      type: "text",
      placeholder: "tusalon",
      description:
        "El nombre de tu página o su enlace. Aparece en tu página de reservas.",
    },
    {
      // The salon's own week, with shifts (components/settings/SalonHoursField).
      // It replaced a single opening/closing pair for every day and a
      // "working days" list that was never saved.
      id: "salonHours",
      label: "Horario del salón",
      type: "salon-hours",
      description:
        "Los días y horas en que abre el salón. Si cierra a mediodía, añade un segundo tramo.",
    },
  ],
  preferences: [
    {
      id: "language",
      label: "Idioma",
      type: "select",
      options: [
        { id: "es", label: "Español" },
        { id: "en", label: "English" },
      ],
      description: "Idioma principal de la interfaz",
    },
    {
      // There was no control for this at all. The screen read tenant.timezone
      // and sent it when it changed, but nothing could change it, so a salon
      // stayed on Europe/Madrid for good -- an hour off in the Canaries.
      id: "timezone",
      label: "Zona horaria",
      type: "select",
      options: SALON_TIMEZONES.map((tz) => ({ id: tz.value, label: tz.label })),
      description:
        "Decide la hora de las citas y de los recordatorios que se envían",
    },
    {
      id: "currency",
      label: "Moneda",
      type: "select",
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
      options: [
        { id: "24", label: "24 horas" },
        { id: "12", label: "12 horas" },
      ],
      description: "Formato de visualización de horas",
    },
  ],
  services: [
    {
      // The step of the slot grid (backend getAvailableSlots), for every
      // place that offers free times.
      id: "bookingSlotMinutes",
      label: "Intervalo de horas al reservar",
      type: "select",
      options: BOOKING_SLOT_OPTIONS.map((m) => ({
        id: String(m),
        label: m === 60 ? "Cada hora" : `Cada ${m} minutos`,
      })),
      description:
        "Cada cuánto se ofrece una hora libre en tu página de reservas, el widget, la recepcionista virtual y las sugerencias de la agenda",
    },
    {
      id: "cancellationPolicy",
      label: "Tiempo máximo para cancelar",
      type: "select",
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
      id: "autoConfirmOnlineBookings",
      label: "Confirmar automáticamente las reservas online",
      type: "switch",
      description:
        "Las citas que piden tus clientes por la web, el widget o la recepcionista virtual entran ya confirmadas. Desactivado, entran como pendientes hasta que las confirmes.",
    },
  ],
  users: [
    {
      id: "allowProfessionalCrossBooking",
      label: "Permitir que profesionales creen citas para otros",
      type: "switch",
      description:
        "Los profesionales pueden crear citas para cualquier profesional activo. Si está desactivado, solo pueden crear citas para sí mismos.",
      adminOnly: true, // Custom flag to show only to owner/admin
    },
  ],
};

/** Settings that live on their own page, linked from the tab they used to sit on. */
const TAB_LINKS: Record<string, Array<{ text: string; href: string; label: string }>> = {
  general: [
    {
      text: "El logo, la descripción y la dirección completa del salón se editan en",
      href: "/dashboard/settings/salon",
      label: "Datos del salón",
    },
  ],
  services: [
    {
      text: "Los mensajes de confirmación y recordatorio de cita los envía KiraRoom; los de WhatsApp, con sus plantillas aprobadas por Meta, se gestionan en",
      href: "/dashboard/settings/whatsapp",
      label: "WhatsApp Business",
    },
  ],
  users: [
    {
      text: "La verificación en dos pasos de tu cuenta está en",
      href: "/dashboard/settings/seguridad",
      label: "Seguridad",
    },
  ],
};

/** An empty value of the right shape, for fields with nothing to show yet. */
function emptyValueFor(field: { type: string }) {
  if (field.type === "salon-hours") return null;
  if (field.type === "switch") return "false";
  return "";
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("general");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [settings, setSettings] = useState(() => {
    const initial: Record<string, any> = {};
    Object.values(defaultSettingsData)
      .flat()
      .forEach((field) => {
        initial[field.id] = emptyValueFor(field);
      });
    return initial;
  });
  // What the tenant holds, as field values: the baseline for "changed".
  const [savedSettings, setSavedSettings] = useState<Record<string, any>>({});
  // Where the salon is, to catch a Canarian salon left on Madrid time.
  const [address, setAddress] = useState<SalonAddress>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // PATCH /auth/tenant is owner/admin only. Read after mount: reading
  // localStorage during render made the server and client renders disagree.
  const [canAccessAdminSettings, setCanAccessAdminSettings] = useState(false);
  useEffect(() => {
    const role = getCurrentUser()?.role;
    setCanAccessAdminSettings(role === "owner" || role === "admin");
  }, []);
  const [professionalCrossBooking, setProfessionalCrossBooking] =
    useState<boolean>(false);
  const [savedCrossBooking, setSavedCrossBooking] = useState<boolean>(false);
  const t = useTranslations();

  useEffect(() => {
    const loadTenantSettings = async () => {
      try {
        const tenant = await apiClient.getTenant();
        const fromTenant = settingsFromTenant(tenant);
        setSavedSettings(fromTenant);
        setAddress({
          street: tenant.street,
          city: tenant.city,
          postalCode: tenant.postalCode,
          state: tenant.state,
          country: tenant.country,
        });
        setSettings((prev) => ({ ...prev, ...fromTenant }));

        // Load professional cross-booking setting
        try {
          const crossBookingSetting =
            await apiClient.getProfessionalCrossBookingSetting();
          setProfessionalCrossBooking(
            crossBookingSetting.allowProfessionalCrossBooking,
          );
          setSavedCrossBooking(crossBookingSetting.allowProfessionalCrossBooking);
        } catch (error) {
          console.error(
            "Error loading professional cross-booking setting:",
            error,
          );
          // Default to false if API call fails
          setProfessionalCrossBooking(false);
        }
      } catch (error) {
        // Say so, rather than logging out: this sent the browser to /login on
        // any error, including a 500. The API client already handles 401.
        console.error("Error loading tenant settings:", error);
        setLoadError(error instanceof Error ? error.message : "Error");
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

  // "Cancelar" puts back what is saved; it used to only clear the tick.
  const handleCancel = () => {
    setSettings((prev) => ({ ...prev, ...savedSettings }));
    setProfessionalCrossBooking(savedCrossBooking);
    setSaveError(null);
    setSuccess(false);
  };

  const handleSubmit = async () => {
    setSaveError(null);

    // The salon's week, checked here so the reason shows next to the day
    // (the editor) and here, rather than as a 400 after saving.
    const hoursProblem = settings.salonHours ? salonHoursProblem(settings.salonHours) : null;
    if (hoursProblem) {
      setSaveError(hoursProblem);
      return;
    }

    setLoading(true);
    try {
      const tenantUpdate = tenantUpdateFrom(settings, savedSettings);
      if (Object.keys(tenantUpdate).length > 0) {
        await apiClient.updateTenant(tenantUpdate);
        // Read back: the server stores a handle as the profile URL.
        const fromTenant = settingsFromTenant(await apiClient.getTenant());
        setSavedSettings(fromTenant);
        setSettings((prev) => ({ ...prev, ...fromTenant }));
      }

      await apiClient.updateProfessionalCrossBookingSetting(
        professionalCrossBooking,
      );
      setSavedCrossBooking(professionalCrossBooking);

      setSuccess(true);
    } catch (error) {
      // It used to fail silently, the button simply returning to "save".
      console.error("Error updating settings:", error);
      setSaveError(error instanceof Error ? error.message : "Error");
    } finally {
      setLoading(false);
    }
  };

  const renderInput = (field: any) => {
    // Skip rendering admin-only fields if user doesn't have permission
    if (field.adminOnly && !canAccessAdminSettings) {
      return null;
    }

    // Only the owner or an admin may change the salon's settings.
    const locked = !canAccessAdminSettings;
    const className = `w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-colors ${locked ? "opacity-50 cursor-not-allowed" : ""}`;

    switch (field.type) {
      case "text":
      case "email":
        return (
          <input
            type={field.type}
            value={settings[field.id]}
            placeholder={field.placeholder}
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
            disabled={locked}
            className={className}
          />
        );

      case "select":
        return (
          <select
            value={settings[field.id]}
            onChange={(e) => handleFieldChange(field.id, e.target.value)}
            disabled={locked}
            className={className}
          >
            {settings[field.id] === "" && <option value="" />}
            {settings[field.id] !== "" &&
              !field.options.some((o: any) => o.id === settings[field.id]) && (
                <option value={settings[field.id]}>{settings[field.id]}</option>
              )}
            {field.options.map((option: any) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        );

      case "switch": {
        // The cross-booking setting has its own endpoint and state.
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
            className={`relative inline-flex items-center ${locked ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={locked}
              onChange={onChange}
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-purple-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
          </label>
        );
      }

      case "salon-hours":
        // Nothing to show until the tenant is read: never a made-up week.
        return settings.salonHours ? (
          <SalonHoursField
            value={settings.salonHours}
            onChange={(next) => handleFieldChange("salonHours", next)}
            disabled={locked}
          />
        ) : null;

      default:
        return null;
    }
  };

  const tabConfig = [
    { id: "general", label: t("settings.general"), icon: Store },
    { id: "preferences", label: t("settings.preferences"), icon: Settings },
    { id: "services", label: t("settings.services"), icon: Calendar },
    { id: "payments", label: t("settings.payments"), icon: CreditCard },
    { id: "users", label: t("settings.users"), icon: Users },
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
          {loadError && (
            <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
              {t("settings.load_failed")}: {loadError}
            </div>
          )}
          {saveError && (
            <div className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
              {t("settings.save_failed")}: {saveError}
            </div>
          )}

          {activeTab === "payments" ? (
            <>
              {/* The tax is the salon's own fiscal setting, saved there; the
                  "Tasa de impuestos" field that stood here was never saved. */}
              <p className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
                {t("settings.tax_moved")}{" "}
                <Link href="/dashboard/settings/fiscal" className="font-medium text-purple-600 hover:text-purple-700">
                  {t("invoices.fiscalSettings.title")}
                </Link>
                .
              </p>
              <StripeSettingsContent />
            </>
          ) : (defaultSettingsData as any)[activeTab] ? (
            <>
              <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                {(defaultSettingsData as any)[activeTab].map((field: any) => (
                  <div
                    key={field.id}
                    className={`space-y-2 ${field.type === "salon-hours" ? "sm:col-span-2" : ""}`}
                  >
                    <label className="block text-sm font-medium text-gray-700">
                      {field.label}
                    </label>
                    {field.description && (
                      <p className="text-xs text-gray-500">{field.description}</p>
                    )}
                    {renderInput(field)}
                    {field.id === "timezone" && canAccessAdminSettings && (
                      <CanaryTimezoneHint
                        timezone={settings.timezone}
                        address={address}
                        onApply={(tz) => handleFieldChange("timezone", tz)}
                      />
                    )}
                  </div>
                ))}
              </div>
              {(TAB_LINKS[activeTab] ?? []).map((link) => (
                <p
                  key={link.href}
                  className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600"
                >
                  {link.text}{" "}
                  <Link href={link.href} className="font-medium text-purple-600 hover:text-purple-700">
                    {link.label}
                  </Link>
                  .
                </p>
              ))}
            </>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">
                No settings available for this tab.
              </p>
            </div>
          )}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end sm:space-x-3 mt-8 pt-6 border-t border-gray-200">
            <button
              onClick={handleCancel}
              className="px-6 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={handleSubmit}
              disabled={loading || !!loadError || !canAccessAdminSettings}
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
        </div>
      </div>
    </div>
  );
}
