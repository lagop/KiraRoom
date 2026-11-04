"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Clock,
  FileText,
  Loader2,
  QrCode,
  Scissors,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import apiClient from "@/lib/api";
import { todayIn, wizardOutcome } from "@/lib/onboarding-wizard";

/**
 * "Más ajustes" (D10). The salon is set up in the dashboard's 3-step overlay
 * (identity, services, team and opening hours); this page used to repeat the
 * services and hours with a second form. It keeps what the overlay does not
 * cover: the test booking, and links to where everything else is changed.
 * Linked from the checklist.
 */

type WizardData = {
  timezone: string;
  hasServices: boolean;
  hasStaff: boolean;
  hasWorkingHours: boolean;
  hasFirstAppointment: boolean;
  /** The salon's active services (the test booking's picker). */
  services?: Array<{ id: string; name: string }>;
};

type SubmitResult = Awaited<ReturnType<typeof apiClient.submitOwnerOnboardingWizard>>;

const LINKS: Array<{ href: string; title: string; desc: string; icon: React.ReactNode }> = [
  {
    href: "/dashboard/services",
    title: "Servicios",
    desc: "Añade, cambia precios y duraciones, o agrupa por categorías.",
    icon: <Scissors className="h-5 w-5" />,
  },
  {
    href: "/dashboard/professionals",
    title: "Equipo",
    desc: "Profesionales, sus horarios y los servicios que hacen.",
    icon: <Users className="h-5 w-5" />,
  },
  {
    href: "/dashboard/settings",
    title: "Horario del salón y reservas",
    desc: "Horario de apertura, antelación para cancelar y cómo se confirman las reservas.",
    icon: <Clock className="h-5 w-5" />,
  },
  {
    href: "/dashboard/settings/fiscal",
    title: "Datos legales y de facturación",
    desc: "Razón social y NIF para las facturas y el aviso legal.",
    icon: <FileText className="h-5 w-5" />,
  },
  {
    href: "/dashboard/clients/import",
    title: "Importar clientas, servicios o citas",
    desc: "Desde la exportación de tu programa anterior (CSV o Excel).",
    icon: <Upload className="h-5 w-5" />,
  },
  {
    href: "/dashboard/compartir",
    title: "Comparte tu página",
    desc: "Tu enlace de reservas, el QR y el código para tu web.",
    icon: <QrCode className="h-5 w-5" />,
  },
];

export default function MoreSettingsPage() {
  const [data, setData] = useState<WizardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<SubmitResult | null>(null);

  const [clientName, setClientName] = useState("");
  const [apService, setApService] = useState("");
  const [apDate, setApDate] = useState("");
  const [apTime, setApTime] = useState("10:00");

  useEffect(() => {
    apiClient
      .getOwnerOnboardingWizard()
      .then((d) => setData(d))
      .catch((e) => {
        const msg = e?.response?.data?.message || e?.message || "No se pudo cargar la página.";
        setLoadError(typeof msg === "string" ? msg : JSON.stringify(msg));
      })
      .finally(() => setLoading(false));
  }, []);

  async function createTestBooking(e: React.FormEvent) {
    e.preventDefault();
    if (!data) return;
    setSubmitError(null);
    setResult(null);
    if (!clientName.trim() || !apService || !apDate || !apTime) {
      setSubmitError("Rellena el nombre, el servicio, la fecha y la hora de la cita de prueba.");
      return;
    }
    if (apDate < todayIn(data.timezone)) {
      setSubmitError("La cita de prueba tiene que ser de hoy en adelante.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiClient.submitOwnerOnboardingWizard({
        firstAppointment: { clientName: clientName.trim(), serviceName: apService, date: apDate, time: apTime },
      });
      setResult(res);
      if (res.saved?.appointment) {
        setClientName("");
        setData({ ...data, hasFirstAppointment: true });
      }
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || "No se pudo crear la cita de prueba.";
      setSubmitError(typeof msg === "string" ? msg : JSON.stringify(msg));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="p-8 text-center">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin inline" />
        <p className="mt-3 text-slate-600">Cargando…</p>
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="p-8">
        <div className="max-w-xl mx-auto p-4 bg-red-50 border border-red-200 rounded text-red-800 text-sm flex items-start gap-2">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span>{loadError ?? "No se pudo cargar la página."}</span>
        </div>
      </div>
    );
  }

  const services = data.services ?? [];
  const outcome = result ? wizardOutcome(result, data) : null;

  return (
    <div className="p-6 max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Más ajustes</h1>
        <p className="text-sm text-slate-600 mt-1">
          Lo básico del salón ya se configura al empezar. Aquí tienes una cita de prueba para ver cómo funciona la
          agenda, y el camino a todo lo demás.
        </p>
      </header>

      <section className="bg-white rounded-lg border border-slate-200 p-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <UserPlus className="w-5 h-5 text-indigo-600" />
          <h2 className="text-lg font-semibold">Cita de prueba</h2>
          {data.hasFirstAppointment && <Check className="w-4 h-4 text-emerald-600 ml-auto" />}
        </div>
        <p className="text-sm text-slate-600 mb-3">
          Aparece en la agenda con la etiqueta «Prueba». No avisa a nadie, no cuenta en las cifras y se borra sola al
          día siguiente, aunque la marques como completada. Solo se queda si la cobras o la facturas.
        </p>
        {!data.hasStaff || services.length === 0 ? (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded text-slate-700 text-sm flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div>
              {!data.hasStaff
                ? "Para crear una cita necesitas al menos un profesional activo en tu equipo. "
                : "Para crear una cita necesitas al menos un servicio activo. "}
              <Link
                href={!data.hasStaff ? "/dashboard/professionals" : "/dashboard/services"}
                className="text-indigo-600 underline"
              >
                {!data.hasStaff ? "Ir a Equipo →" : "Ir a Servicios →"}
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={createTestBooking} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <label className="block">
                <span className="block text-xs text-slate-600 mb-1">Cliente</span>
                <input
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Cliente de prueba"
                  className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
                />
              </label>
              <label className="block">
                <span className="block text-xs text-slate-600 mb-1">Servicio</span>
                <select
                  value={apService}
                  onChange={(e) => setApService(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded bg-white"
                >
                  <option value="">Elige un servicio</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-slate-600 mb-1">Fecha</span>
                <input
                  type="date"
                  // From today on the salon's clock (the server refuses past ones too).
                  min={todayIn(data.timezone)}
                  value={apDate}
                  onChange={(e) => setApDate(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
                />
              </label>
              <label className="block">
                {/* The server stores it as the salon's wall-clock time, not the browser's. */}
                <span className="block text-xs text-slate-600 mb-1">Hora (del salón, {data.timezone})</span>
                <input
                  type="time"
                  value={apTime}
                  onChange={(e) => setApTime(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
                />
              </label>
            </div>
            {submitError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded text-red-800 text-sm flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>{submitError}</span>
              </div>
            )}
            {outcome && (outcome.warning || outcome.lines.length > 0) && (
              <div
                className={`p-3 rounded text-sm flex items-start gap-2 border ${
                  outcome.warning
                    ? "bg-amber-50 border-amber-200 text-amber-900"
                    : "bg-emerald-50 border-emerald-200 text-emerald-900"
                }`}
              >
                {outcome.warning ? (
                  <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                ) : (
                  <Check className="w-4 h-4 mt-0.5 flex-shrink-0" />
                )}
                <span>
                  {outcome.warning ?? outcome.lines.join(" ")}{" "}
                  {result?.saved?.appointment && (
                    <Link href="/dashboard/appointments" className="underline font-medium">
                      Ver la agenda
                    </Link>
                  )}
                </span>
              </div>
            )}
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Crear cita de prueba
              </button>
            </div>
          </form>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Dónde cambiar cada cosa</h2>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className="flex h-full items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 hover:border-indigo-300 hover:bg-indigo-50/40"
              >
                <span className="text-indigo-600">{l.icon}</span>
                <span className="flex-1">
                  <span className="block text-sm font-medium text-slate-900">{l.title}</span>
                  <span className="block text-xs text-slate-500 mt-0.5">{l.desc}</span>
                </span>
                <ChevronRight className="h-4 w-4 text-slate-400 mt-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
