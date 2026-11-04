"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  Check,
  Clock,
  Loader2,
  Scissors,
  UserPlus,
} from "lucide-react";
import apiClient from "@/lib/api";
import { WeeklyScheduleEditor } from "@/components/professionals/WeeklyScheduleEditor";
import {
  defaultSchedule,
  scheduleFromWorkingHours,
  scheduleProblems,
  workingHoursFromSchedule,
  type WeeklySchedule,
} from "@/lib/weekly-schedule";
import { customServiceProblem, todayIn, wizardHoursToSend, wizardOutcome } from "@/lib/onboarding-wizard";

type WizardData = {
  tenantId: string;
  currency: string;
  timezone: string;
  hasServices: boolean;
  hasStaff: boolean;
  hasWorkingHours: boolean;
  openingHours?: Array<{ day: string; openTime: string; closeTime: string }>;
  hasFirstAppointment: boolean;
  serviceTemplates: Array<{
    name: string;
    durationMinutes: number;
    price: number;
  }>;
  /** The salon's active services (the test booking's picker). */
  services?: Array<{ id: string; name: string }>;
};

type SubmitResult = Awaited<ReturnType<typeof apiClient.submitOwnerOnboardingWizard>>;

export default function OwnerOnboardingWizardPage() {
  const router = useRouter();
  const [data, setData] = useState<WizardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // What the server says it saved: the closing screen is built from it (O4).
  const [result, setResult] = useState<SubmitResult | null>(null);

  const [selectedTemplates, setSelectedTemplates] = useState<Set<string>>(new Set());
  const [customServices, setCustomServices] = useState<
    Array<{ name: string; durationMinutes: number; price: number }>
  >([]);

  // The salon's week, with shifts (a salon that closes at midday has two a
  // day): the saved one when there is one, else Monday to Friday, 09:00 to
  // 19:00 until the owner changes it.
  const [hours, setHours] = useState<WeeklySchedule>(defaultSchedule);
  // Only a week the owner touched (or the first one, when none is saved) is
  // sent: "Guardar y empezar" used to overwrite the salon's hours with the
  // default week.
  const [hoursTouched, setHoursTouched] = useState(false);

  const [clientName, setClientName] = useState("");
  const [apDate, setApDate] = useState("");
  const [apTime, setApTime] = useState("10:00");
  // The test booking's service, from the salon's real ones and those ticked
  // or typed above (it used to be the first ticked, or "Corte de cabello").
  const [apService, setApService] = useState("");

  useEffect(() => {
    apiClient
      .getOwnerOnboardingWizard()
      .then((d) => {
        setData(d);
        const saved = scheduleFromWorkingHours(d.openingHours ?? []);
        if (saved) setHours(saved);
      })
      .catch((e) => {
        const msg =
          e?.response?.data?.message ||
          e?.message ||
          "No se pudo cargar el configurador.";
        setLoadError(typeof msg === "string" ? msg : JSON.stringify(msg));
      })
      .finally(() => setLoading(false));
  }, []);

  function toggleTemplate(name: string) {
    setSelectedTemplates((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function addCustom() {
    setCustomServices((prev) => [
      ...prev,
      { name: "", durationMinutes: 30, price: 0 },
    ]);
  }

  function updateCustom(i: number, patch: Partial<{ name: string; durationMinutes: number; price: number }>) {
    setCustomServices((prev) =>
      prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    );
  }

  function removeCustom(i: number) {
    setCustomServices((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit() {
    if (!data) return;
    setSubmitError(null);
    // A shift that ends before it starts (or two that overlap) is refused
    // here, next to the day it is on, before anything is saved. A week with
    // no open day is fine: no salon hours are stored, as before.
    if (Object.keys(scheduleProblems(hours).days).length > 0) {
      setSubmitError("Revisa el horario de apertura: hay tramos que no se pueden guardar.");
      return;
    }
    // Checked here, in Spanish, before the server refuses it (O14).
    const customProblem = customServices.map(customServiceProblem).find(Boolean);
    if (customProblem) {
      setSubmitError(customProblem);
      return;
    }
    const wantsAppointment = Boolean(clientName.trim() && apDate && apTime) && data.hasStaff;
    if (wantsAppointment && !apService) {
      setSubmitError("Elige el servicio de la cita de prueba.");
      return;
    }
    if (wantsAppointment && apDate < todayIn(data.timezone)) {
      setSubmitError("La cita de prueba tiene que ser de hoy en adelante.");
      return;
    }
    setSubmitting(true);

    const services: Array<{ name: string; durationMinutes: number; price: number }> = [];
    for (const t of data.serviceTemplates) {
      if (selectedTemplates.has(t.name)) {
        services.push(t);
      }
    }
    for (const c of customServices) {
      if (c.name.trim()) services.push(c);
    }

    const openingHours = wizardHoursToSend(
      workingHoursFromSchedule(hours),
      hoursTouched,
      data.hasWorkingHours,
    );

    // The appointment block only makes sense once the owner has added
    // at least one Professional — without one, the server silently
    // skips the create (FK constraint) and returns
    // skipped.appointment='no_staff'. Gate the input on the snapshot
    // so the user knows *before* submitting why the field is dead.
    const appointmentRequested = wantsAppointment;

    try {
      const res = await apiClient.submitOwnerOnboardingWizard({
        services: services.length ? services : undefined,
        openingHours,
        firstAppointment: appointmentRequested
          ? {
              clientName: clientName.trim(),
              serviceName: apService,
              date: apDate,
              time: apTime,
            }
          : undefined,
      });
      setResult(res);
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        "No se pudo guardar la configuración.";
      setSubmitError(typeof msg === "string" ? msg : JSON.stringify(msg));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="p-8 text-center">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin inline" />
        <p className="mt-3 text-slate-600">Cargando configurador…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-8">
        <div className="max-w-xl mx-auto p-4 bg-red-50 border border-red-200 rounded text-red-800 text-sm flex items-start gap-2">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <span>{loadError}</span>
        </div>
      </div>
    );
  }

  if (!data) return null;

  if (result) {
    // Built from what was actually saved, with the reason a test booking was
    // not created (it used to say "¡Tu salón está listo!" whatever happened).
    const outcome = wizardOutcome(result, data);
    return (
      <div className="p-8">
        <div className="max-w-xl mx-auto text-center py-12">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-emerald-100 rounded-full mb-3">
            <Check className="w-6 h-6 text-emerald-600" />
          </div>
          <h1 className="text-2xl font-bold mb-2">{outcome.title}</h1>
          {outcome.lines.length > 0 && (
            <ul className="text-slate-600 mb-4 space-y-1">
              {outcome.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          {outcome.warning && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-amber-900 text-sm flex items-start gap-2 text-left">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{outcome.warning}</span>
            </div>
          )}
          <p className="text-slate-600 mb-6">
            {outcome.readyForBookings
              ? "Comparte tu enlace de reservas o el QR para que tus clientas reserven solas."
              : "Para recibir reservas online necesitas servicios, al menos un profesional activo y el horario de apertura."}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {outcome.readyForBookings && (
              <Link
                href="/dashboard/compartir"
                className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
              >
                Comparte tu página
              </Link>
            )}
            <button
              type="button"
              onClick={() => router.push("/dashboard")}
              className={
                outcome.readyForBookings
                  ? "px-4 py-2 border border-slate-300 rounded-md hover:bg-slate-50"
                  : "px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
              }
            >
              Ir al panel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // The test booking's service: the salon's own, plus those ticked or typed
  // above (matched on the server without case, as here).
  const serviceOptions: string[] = [];
  const seenOption = new Set<string>();
  for (const name of [
    ...(data.services ?? []).map((s) => s.name),
    ...data.serviceTemplates.filter((t) => selectedTemplates.has(t.name)).map((t) => t.name),
    ...customServices.map((c) => c.name.trim()).filter(Boolean),
  ]) {
    const key = name.trim().replace(/\s+/g, " ").toLowerCase();
    if (seenOption.has(key)) continue;
    seenOption.add(key);
    serviceOptions.push(name);
  }
  const today = todayIn(data.timezone);

  const alreadyDone = data.hasServices && data.hasStaff && data.hasWorkingHours && data.hasFirstAppointment;

  return (
    <div className="p-6 max-w-3xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Configura tu salón</h1>
        <p className="text-sm text-slate-600 mt-1">
          Tres pasos para empezar a recibir reservas. Puedes volver más
          tarde para añadir más.
        </p>
      </header>

      {alreadyDone && (
        <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded text-emerald-800 text-sm">
          Ya tienes todo configurado. Vuelve al panel o añade más detalles.
        </div>
      )}

      {/* Step 1 — services */}
      <section className="bg-white rounded-lg border border-slate-200 p-5 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Scissors className="w-5 h-5 text-indigo-600" />
          <h2 className="text-lg font-semibold">1. Servicios</h2>
          {data.hasServices && <Check className="w-4 h-4 text-emerald-600 ml-auto" />}
        </div>
        <p className="text-sm text-slate-600 mb-3">
          Marca los servicios típicos de un salón de belleza. Después
          podrás añadir más desde el panel.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {data.serviceTemplates.map((t) => (
            <label key={t.name} className="flex items-start gap-2 p-2 border border-slate-200 rounded hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedTemplates.has(t.name)}
                onChange={() => toggleTemplate(t.name)}
                className="mt-1"
              />
              <span className="flex-1">
                <span className="block text-sm font-medium">{t.name}</span>
                <span className="block text-xs text-slate-500">
                  {t.durationMinutes} min · {t.price} {data.currency}
                </span>
              </span>
            </label>
          ))}
        </div>

        {customServices.length > 0 && (
          <div className="mt-4 space-y-2">
            <p className="text-sm font-medium text-slate-700">Personalizados:</p>
            {customServices.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={c.name}
                  onChange={(e) => updateCustom(i, { name: e.target.value })}
                  placeholder="Nombre del servicio"
                  className="flex-1 px-2 py-1 text-sm border border-slate-300 rounded"
                />
                <input
                  type="number"
                  value={c.durationMinutes}
                  onChange={(e) =>
                    updateCustom(i, { durationMinutes: Number(e.target.value) || 0 })
                  }
                  placeholder="min"
                  className="w-20 px-2 py-1 text-sm border border-slate-300 rounded"
                />
                <input
                  type="number"
                  value={c.price}
                  onChange={(e) => updateCustom(i, { price: Number(e.target.value) || 0 })}
                  placeholder="€"
                  className="w-20 px-2 py-1 text-sm border border-slate-300 rounded"
                />
                <button
                  type="button"
                  onClick={() => removeCustom(i)}
                  className="text-red-600 text-sm hover:underline"
                >
                  Quitar
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={addCustom}
          className="mt-3 text-sm text-indigo-600 hover:underline"
        >
          + Añadir servicio personalizado
        </button>
      </section>

      {/* Step 2 — working hours */}
      <section className="bg-white rounded-lg border border-slate-200 p-5 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-5 h-5 text-indigo-600" />
          <h2 className="text-lg font-semibold">2. Horario de apertura</h2>
          {data.hasWorkingHours && <Check className="w-4 h-4 text-emerald-600 ml-auto" />}
        </div>
        <p className="text-sm text-slate-600 mb-3">
          {data.hasWorkingHours
            ? "Este es el horario que tienes guardado. Si no lo cambias, se queda como está."
            : "Marca los días y las horas en que abre el salón."}{" "}
          Las reservas online solo ofrecen horas dentro de este horario, aunque el
          horario de cada profesional sea más amplio.
        </p>
        <WeeklyScheduleEditor
          variant="salon"
          value={hours}
          onChange={(next) => {
            setHours(next);
            setHoursTouched(true);
          }}
          disabled={submitting}
          weekProblem={null}
        />
      </section>

      {/* Step 3 — first appointment */}
      <section className="bg-white rounded-lg border border-slate-200 p-5 mb-4">
        <div className="flex items-center gap-2 mb-3">
          <UserPlus className="w-5 h-5 text-indigo-600" />
          <h2 className="text-lg font-semibold">3. Primera cita (opcional)</h2>
          {data.hasFirstAppointment && (
            <Check className="w-4 h-4 text-emerald-600 ml-auto" />
          )}
        </div>
        <p className="text-sm text-slate-600 mb-3">
          Crea una cita de prueba para ver cómo queda en la agenda. No
          cuenta en las cifras ni queda pendiente de cobro, y se borra sola
          al día siguiente.
        </p>
        {!data.hasStaff && (
          // A1.2 follow-up: the appointment step is gated on having at
          // least one Professional on the tenant. We don't silently
          // ignore the input — instead we explain the prerequisite
          // and offer a link to the right page.
          (
            <div className="mb-3 p-3 bg-slate-50 border border-slate-200 rounded text-slate-700 text-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div>
                Para crear una cita necesitas haber añadido al menos un
                profesional a tu equipo.{" "}
                <Link
                  href="/dashboard/professionals"
                  className="text-indigo-600 underline"
                >
                  Ir a Equipo →
                </Link>
              </div>
            </div>
          )
        )}
        <fieldset
          disabled={!data.hasStaff}
          className="grid grid-cols-1 md:grid-cols-4 gap-3"
        >
          <label className="block">
            <span className="block text-xs text-slate-600 mb-1">Servicio</span>
            <select
              value={apService}
              onChange={(e) => setApService(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded bg-white"
            >
              <option value="">
                {serviceOptions.length > 0 ? "Elige un servicio" : "Marca o crea un servicio arriba"}
              </option>
              {serviceOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-slate-600 mb-1">
              Cliente
            </span>
            <input
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Cliente de prueba"
              className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
            />
          </label>
          <label className="block">
            <span className="block text-xs text-slate-600 mb-1">Fecha</span>
            <input
              type="date"
              // From today on the salon's clock (the server refuses past ones too).
              min={today}
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
        </fieldset>
      </section>

      {submitError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-800 text-sm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{submitError}</span>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push("/dashboard")}
          className="px-4 py-2 text-sm border border-slate-300 rounded-md hover:bg-slate-50"
          disabled={submitting}
        >
          Saltar por ahora
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={submitting}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          Guardar y empezar
        </button>
      </div>
    </div>
  );
}