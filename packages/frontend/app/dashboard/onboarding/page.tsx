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

type WizardData = {
  tenantId: string;
  currency: string;
  timezone: string;
  hasServices: boolean;
  hasStaff: boolean;
  hasWorkingHours: boolean;
  hasFirstAppointment: boolean;
  serviceTemplates: Array<{
    name: string;
    durationMinutes: number;
    price: number;
  }>;
};

const DAYS = [
  { key: "mon", label: "Lunes" },
  { key: "tue", label: "Martes" },
  { key: "wed", label: "Miércoles" },
  { key: "thu", label: "Jueves" },
  { key: "fri", label: "Viernes" },
  { key: "sat", label: "Sábado" },
  { key: "sun", label: "Domingo" },
];

export default function OwnerOnboardingWizardPage() {
  const router = useRouter();
  const [data, setData] = useState<WizardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [skipWarning, setSkipWarning] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [selectedTemplates, setSelectedTemplates] = useState<Set<string>>(new Set());
  const [customServices, setCustomServices] = useState<
    Array<{ name: string; durationMinutes: number; price: number }>
  >([]);

  const [hours, setHours] = useState<
    Record<string, { open: string; close: string } | null>
  >({
    mon: { open: "09:00", close: "19:00" },
    tue: { open: "09:00", close: "19:00" },
    wed: { open: "09:00", close: "19:00" },
    thu: { open: "09:00", close: "19:00" },
    fri: { open: "09:00", close: "19:00" },
    sat: null,
    sun: null,
  });

  const [clientName, setClientName] = useState("");
  const [apDate, setApDate] = useState("");
  const [apTime, setApTime] = useState("10:00");

  useEffect(() => {
    apiClient
      .getOwnerOnboardingWizard()
      .then((d) => setData(d))
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

  function toggleDay(key: string) {
    setHours((prev) => ({ ...prev, [key]: prev[key] ? null : { open: "09:00", close: "19:00" } }));
  }

  function updateDay(key: string, patch: { open?: string; close?: string }) {
    setHours((prev) => {
      const cur = prev[key];
      if (!cur) return prev;
      return { ...prev, [key]: { ...cur, ...patch } };
    });
  }

  async function submit() {
    if (!data) return;
    setSubmitting(true);
    setSubmitError(null);
    setSkipWarning(null);

    const services: Array<{ name: string; durationMinutes: number; price: number }> = [];
    for (const t of data.serviceTemplates) {
      if (selectedTemplates.has(t.name)) {
        services.push(t);
      }
    }
    for (const c of customServices) {
      if (c.name.trim()) services.push(c);
    }

    const filteredHours: Record<string, { open: string; close: string }> = {};
    for (const [k, v] of Object.entries(hours)) {
      if (v) filteredHours[k] = v;
    }

    // The appointment block only makes sense once the owner has added
    // at least one Professional — without one, the server silently
    // skips the create (FK constraint) and returns
    // skipped.appointment='no_staff'. Gate the input on the snapshot
    // so the user knows *before* submitting why the field is dead.
    const appointmentRequested =
      Boolean(clientName.trim() && apDate && apTime) && data.hasStaff;

    try {
      const res = await apiClient.submitOwnerOnboardingWizard({
        services: services.length ? services : undefined,
        workingHours: Object.keys(filteredHours).length ? filteredHours : undefined,
        firstAppointment: appointmentRequested
          ? {
              clientName: clientName.trim(),
              serviceName:
                services[0]?.name ?? data.serviceTemplates[0]?.name ?? "",
              date: apDate,
              time: apTime,
            }
          : undefined,
      });
      // Surface any silent skip from the server so the user knows
      // the appointment step wasn't actually completed.
      if (res?.skipped?.appointment === "no_staff") {
        setSkipWarning(
          "Has rellenado los datos de la primera cita, pero la cuenta aún no tiene profesionales. " +
            "Añade al menos un miembro del equipo desde el panel y vuelve aquí para registrar la cita.",
        );
      } else if (res?.skipped?.appointment === "no_service") {
        setSkipWarning(
          "El servicio de la cita de prueba no coincide con ninguno de los servicios que has añadido. " +
            "Marca o crea el servicio correspondiente en el paso 1 antes de continuar.",
        );
      }
      setDone(true);
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

  if (done) {
    return (
      <div className="p-8">
        <div className="max-w-xl mx-auto text-center py-12">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-emerald-100 rounded-full mb-3">
            <Check className="w-6 h-6 text-emerald-600" />
          </div>
          <h1 className="text-2xl font-bold mb-2">
            ¡Tu salón está listo!
          </h1>
          <p className="text-slate-600 mb-6">
            Ya puedes empezar a recibir reservas.
          </p>
          <button
            type="button"
            onClick={() => router.push("/dashboard")}
            className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
          >
            Ir al panel
          </button>
        </div>
      </div>
    );
  }

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

      {skipWarning && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-amber-900 text-sm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{skipWarning}</span>
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
        <div className="space-y-2">
          {DAYS.map((d) => {
            const h = hours[d.key];
            const open = !!h;
            return (
              <div key={d.key} className="flex items-center gap-3">
                <label className="flex items-center gap-2 w-32">
                  <input
                    type="checkbox"
                    checked={open}
                    onChange={() => toggleDay(d.key)}
                  />
                  <span className="text-sm">{d.label}</span>
                </label>
                {open && h && (
                  <>
                    <input
                      type="time"
                      value={h.open}
                      onChange={(e) => updateDay(d.key, { open: e.target.value })}
                      className="px-2 py-1 text-sm border border-slate-300 rounded"
                    />
                    <span className="text-slate-500">–</span>
                    <input
                      type="time"
                      value={h.close}
                      onChange={(e) => updateDay(d.key, { close: e.target.value })}
                      className="px-2 py-1 text-sm border border-slate-300 rounded"
                    />
                  </>
                )}
                {!open && (
                  <span className="text-xs text-slate-400">Cerrado</span>
                )}
              </div>
            );
          })}
        </div>
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
          Crea una cita de prueba con un cliente ficticio para verificar
          que el sistema funciona.
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
                  href="/dashboard/team"
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
          className="grid grid-cols-1 md:grid-cols-3 gap-3"
        >
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
              value={apDate}
              onChange={(e) => setApDate(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-slate-300 rounded"
            />
          </label>
          <label className="block">
            <span className="block text-xs text-slate-600 mb-1">Hora</span>
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