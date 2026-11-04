"use client";

import { useEffect, useRef, useState } from "react";
import { useOnboardingState } from "./useOnboardingState";
import { Loader2, Check, AlertCircle, Building2, Scissors, Clock, Upload, LogOut } from "lucide-react";
import { signOut } from "@/lib/sign-out";
import { useTranslations } from "@/lib/use-translation";
import apiClient from "@/lib/api";
import { CanaryTimezoneHint } from "@/components/settings/CanaryTimezoneHint";
import { WeeklyScheduleEditor } from "@/components/professionals/WeeklyScheduleEditor";
import {
  defaultSchedule,
  scheduleProblems,
  workingHoursFromSchedule,
  type WeeklySchedule,
} from "@/lib/weekly-schedule";

/**
 * Inline 3-step wizard. Each linear_required step renders its own form
 * inside the overlay; on submit the relevant API is called, the
 * onboarding state is refetched, and the detector on the server marks
 * the step done → the overlay auto-advances to the next step.
 *
 * No navigation away from the current page; no localStorage hacks;
 * server is source of truth for `currentStep`.
 */
export function OnboardingLinearOverlay() {
  const t = useTranslations();
  // No timer: each step's onDone refetches, as do page moves and tab focus.
  const { data, isLoading, refetch } = useOnboardingState();

  if (isLoading || !data) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/80 backdrop-blur">
        <Loader2 className="h-8 w-8 animate-spin text-violet-600" />
      </div>
    );
  }

  const linearDefs = data.defs.filter((d) => d.group === "linear_required");
  if (linearDefs.length === 0) return null;
  if (data.finishedAt || data.currentStep >= linearDefs.length) return null;

  const idx = Math.min(data.currentStep, linearDefs.length - 1);
  const def = linearDefs[idx];

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-violet-50/95 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-8 shadow-xl max-h-[90vh] overflow-y-auto">
        <ProgressDots total={linearDefs.length} current={idx} />

        <div className="mt-4 text-xs font-medium uppercase tracking-wide text-violet-600">
          {t("onboarding.linear.step", {
            current: idx + 1,
            total: linearDefs.length,
          })}
        </div>
        <h1 className="text-2xl font-bold text-gray-900">
          {t("onboarding.linear.title")}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {t("onboarding.linear.subtitle")}
        </p>

        <div className="mt-6">
          {def.key === "workspace_business" && (
            <WorkspaceBusinessStep onDone={refetch} />
          )}
          {def.key === "service_create" && (
            <ServiceCreateStep onDone={refetch} />
          )}
          {def.key === "schedule_set" && (
            <ScheduleSetStep onDone={refetch} />
          )}
          {![
            "workspace_business",
            "service_create",
            "schedule_set",
          ].includes(def.key) && (
            <UnknownStepFallback title={t(def.titleI18nKey)} desc={t(def.descI18nKey)} />
          )}
        </div>

        {/* A way out (O3): on a shared computer, or to carry on later, the
            only exit used to be closing the tab. */}
        <SignOutFooter />
      </div>
    </div>
  );
}

function SignOutFooter() {
  const t = useTranslations();
  const [leaving, setLeaving] = useState(false);
  return (
    <div className="mt-8 flex flex-col gap-2 border-t border-slate-100 pt-4 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
      <span>{t("onboarding.linear.later")}</span>
      <button
        type="button"
        disabled={leaving}
        onClick={async () => {
          setLeaving(true);
          await signOut();
        }}
        className="inline-flex items-center gap-1.5 self-start rounded-md px-2 py-1 font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50 sm:self-auto"
      >
        <LogOut className="h-4 w-4" aria-hidden="true" />
        {leaving ? t("common.loading") : t("nav.logout")}
      </button>
    </div>
  );
}

function ProgressDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-2 flex-1 rounded-full ${
            i < current ? "bg-emerald-500" : i === current ? "bg-violet-600" : "bg-slate-200"
          }`}
        />
      ))}
    </div>
  );
}

function StepHeader({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="rounded-lg border border-violet-100 bg-violet-50/50 p-4">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-violet-600 text-white">
          {icon}
        </span>
        <div>
          <div className="text-base font-semibold text-gray-900">{title}</div>
          <div className="mt-1 text-sm text-gray-600">{desc}</div>
        </div>
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  );
}

function StepSubmitButton({
  submitting,
  label,
}: {
  submitting: boolean;
  label: string;
}) {
  return (
    <button
      type="submit"
      disabled={submitting}
      className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
    >
      {submitting ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Check className="h-4 w-4" />
      )}
      {label}
    </button>
  );
}

// ─── Step 1 — Tenant identity ──────────────────────────────────────
function WorkspaceBusinessStep({ onDone }: { onDone: () => Promise<unknown> }) {
  const t = useTranslations();
  const [name, setName] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  // The postcode decides the tax too: 35/38 IGIC, 51/52 IPSI (audit 7 N6).
  const [postalCode, setPostalCode] = useState("");
  const [phone, setPhone] = useState("");
  const [logo, setLogo] = useState("");
  // The zone the salon signed up on: a Canarian address on Madrid time is
  // switched to Canary time when this step saves (PATCH /auth/tenant).
  const [timezone, setTimezone] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill from current tenant state if present
  useEffect(() => {
    apiClient
      .getTenant()
      .then((t: any) => {
        if (t?.name) setName(t.name);
        if (t?.street) setStreet(t.street);
        if (t?.city) setCity(t.city);
        if (t?.postalCode) setPostalCode(t.postalCode);
        if (t?.phone) setPhone(t.phone);
        if (t?.logo) setLogo(t.logo);
        if (t?.timezone) setTimezone(t.timezone);
      })
      .catch(() => {
        /* first-time tenants will 404 / be empty — that's fine */
      });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // The logo is optional on purpose: requiring it here blocked the
    // whole dashboard behind an image upload. It stays in the optional
    // branding step of the checklist.
    if (!name.trim() || !street.trim() || !city.trim() || !phone.trim()) {
      setError("Rellena el nombre, la dirección y el teléfono para continuar.");
      return;
    }
    if (!/^\d{5}$/.test(postalCode.replace(/\s+/g, ""))) {
      setError("Escribe el código postal del salón (5 números).");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.updateTenant({
        name: name.trim(),
        street: street.trim(),
        city: city.trim(),
        postalCode: postalCode.replace(/\s+/g, ""),
        phone: phone.trim(),
        logo: logo.trim(),
      } as any);
      await onDone();
      // Overlay will re-render on the next query refetch and show step 2.
    } catch (e: any) {
      setError(
        e?.response?.data?.message || e?.message || "No se pudo guardar la identidad.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-4">
      <StepHeader
        icon={<Building2 className="h-5 w-5" />}
        title={t("onboarding.workspace_business.title")}
        desc={t("onboarding.workspace_business.desc")}
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Field label="Nombre del salón" value={name} onChange={setName} required />
        <Field label="Teléfono" value={phone} onChange={setPhone} required type="tel" />
        <Field label="Dirección" value={street} onChange={setStreet} required className="md:col-span-2" />
        <Field label="Ciudad" value={city} onChange={setCity} required />
        <Field label="Código postal" value={postalCode} onChange={setPostalCode} required placeholder="28001" />
        <LogoUpload value={logo} onChange={setLogo} className="md:col-span-2" />
      </div>
      <CanaryTimezoneHint timezone={timezone} address={{ street, city, postalCode }} />
      <ErrorBanner message={error} />
      <div className="flex justify-end">
        <StepSubmitButton submitting={submitting} label="Guardar y continuar" />
      </div>
    </form>
  );
}

// ─── Step 2 — first service ────────────────────────────────────────
function ServiceCreateStep({ onDone }: { onDone: () => Promise<unknown> }) {
  const t = useTranslations();
  const [name, setName] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [price, setPrice] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || durationMinutes <= 0 || price < 0) {
      setError("Indica un nombre, una duración en minutos y un precio.");
      return;
    }
    if (durationMinutes < 5) {
      setError("El servicio tiene que durar al menos 5 minutos.");
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.createService({
        name: name.trim(),
        category: "other",
        duration: durationMinutes,
        price,
        currency: "EUR",
      });
      await onDone();
    } catch (e: any) {
      setError(
        e?.response?.data?.message || e?.message || "No se pudo crear el servicio.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-4">
      <StepHeader
        icon={<Scissors className="h-5 w-5" />}
        title={t("onboarding.service_create.title")}
        desc={t("onboarding.service_create.desc")}
      />
      <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
        <Field label="Nombre del servicio" value={name} onChange={setName} required className="md:col-span-3" />
        <Field
          label="Duración (min)"
          value={String(durationMinutes)}
          onChange={(v) => setDurationMinutes(Number(v) || 0)}
          required
          type="number"
          className="md:col-span-1"
        />
        <Field
          label="Precio (€)"
          value={String(price)}
          onChange={(v) => setPrice(Number(v) || 0)}
          required
          type="number"
          className="md:col-span-2"
        />
      </div>
      <ErrorBanner message={error} />
      <div className="flex justify-end">
        <StepSubmitButton submitting={submitting} label="Guardar y continuar" />
      </div>
    </form>
  );
}

// ─── Step 3 — first professional + working hours ──────────────────
// The `schedule_set` detector checks `allProsHaveWorkingHours`, which
// requires at least one active Professional with a non-empty
// `workingHours` array. So this step does both: create the pro AND
// set their hours in a single inline form.
function ScheduleSetStep({ onDone }: { onDone: () => Promise<unknown> }) {
  const t = useTranslations();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  // Monday to Friday, 09:00 to 19:00 until the salon changes it; a day can
  // have several shifts (jornada partida).
  const [schedule, setSchedule] = useState<WeeklySchedule>(defaultSchedule);
  // Services this professional performs. Fetched on mount; the backend's
  // `createProfessional` accepts `serviceIds` and persists the join rows
  // so the new pro is bookable from day one.
  const [services, setServices] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedServiceIds, setSelectedServiceIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .getServices()
      .then((rows: any[]) => {
        const list = (rows || [])
          .filter((s) => s && s.id && s.name)
          .map((s) => ({ id: s.id as string, name: s.name as string }));
        setServices(list);
      })
      .catch(() => {
        /* First-time tenants may have no services yet — render an empty
           list and a hint to add services from /dashboard/services. */
        setServices([]);
      });
  }, []);

  function toggleService(id: string) {
    setSelectedServiceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!firstName.trim() || !lastName.trim()) {
      setError("Rellena nombre y apellidos del profesional.");
      return;
    }
    // Refused here, before saving, as the server would: no working day, a
    // shift that ends before it starts, overlapping shifts. Each day's
    // problem is also shown next to it in the editor.
    const problems = scheduleProblems(schedule);
    if (problems.week) {
      setError("Selecciona al menos un día de trabajo para el profesional.");
      return;
    }
    if (Object.keys(problems.days).length > 0) {
      setError("Revisa el horario: hay tramos que no se pueden guardar.");
      return;
    }
    // Checked here, in Spanish: the server's refusal reached the owner as
    // "email must be an email" (O14).
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("El email del profesional no es válido. Corrígelo o déjalo vacío.");
      return;
    }
    // [{ day, openTime, closeTime }, ...]: one entry per shift.
    const workingHours = workingHoursFromSchedule(schedule);
    if (services.length > 0 && selectedServiceIds.size === 0) {
      setError("Asigna al menos un servicio al profesional.");
      return;
    }

    // Email is optional in the UI. The DB column is `String @unique`
    // (not nullable), so generate a placeholder when blank — the user
    // can edit it later from /dashboard/professionals. This avoids the
    // "Professional with this email already exists" 400 on retries.
    const finalEmail = email.trim() || `pro-${Date.now()}@placeholder.local`;

    setSubmitting(true);
    try {
      await apiClient.createProfessional({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: finalEmail,
        isActive: true,
        workingHours,
        serviceIds: Array.from(selectedServiceIds),
      } as any);
      await onDone();
    } catch (e: any) {
      // api.ts throws `new Error(errorData.message || "API Error: ...")`
      // for fetch-based requests, so `e.response` is undefined. Fall
      // back to `e.message` which carries the server's plain-text error.
      const message =
        (Array.isArray(e?.message) ? e.message.join(" · ") : e?.message) ||
        "No se pudo crear el profesional.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-4">
      <StepHeader
        icon={<Clock className="h-5 w-5" />}
        title={t("onboarding.schedule_set.title")}
        desc={t("onboarding.schedule_set.desc")}
      />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Nombre" value={firstName} onChange={setFirstName} required />
        <Field label="Apellidos" value={lastName} onChange={setLastName} required />
        <Field
          label="Email (opcional)"
          value={email}
          onChange={setEmail}
          type="email"
          placeholder="Se generará uno automáticamente si lo dejas vacío"
        />
      </div>
      <div>
        <p className="text-xs font-medium text-slate-700 mb-2">
          Horario de trabajo
        </p>
        <WeeklyScheduleEditor
          compact
          value={schedule}
          onChange={setSchedule}
          disabled={submitting}
          weekProblem="Marca al menos un día de trabajo."
        />
      </div>
      {/* Services this professional performs — at least one required so the
          new pro is bookable from day one. The list is fetched once on
          mount and falls back to an empty list if the tenant hasn't
          created any services yet. */}
      <div>
        <p className="text-xs font-medium text-slate-700 mb-1">
          Servicios que realiza
          <span className="text-red-500 ml-0.5">*</span>
        </p>
        {services.length === 0 ? (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">
            Aún no hay servicios creados. Añade al menos uno en{" "}
            <a href="/dashboard/services" className="underline font-medium">
              /dashboard/services
            </a>{" "}
            antes de continuar, o el profesional no podrá recibir reservas.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {services.map((s) => {
              const checked = selectedServiceIds.has(s.id);
              return (
                <label
                  key={s.id}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer transition-colors ${
                    checked
                      ? "border-violet-500 bg-violet-50"
                      : "border-slate-200 bg-white hover:bg-slate-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleService(s.id)}
                  />
                  <span className="text-sm text-slate-800">{s.name}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      <ErrorBanner message={error} />
      <div className="flex justify-end">
        <StepSubmitButton submitting={submitting} label="Guardar y terminar" />
      </div>
    </form>
  );
}

// ─── Fallback (defensive — if backend adds a new linear step) ─────
function UnknownStepFallback({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mt-4 space-y-4">
      <StepHeader
        icon={<Check className="h-5 w-5" />}
        title={title}
        desc={desc}
      />
      <p className="text-sm text-slate-600">
        Este paso se completa automáticamente al detectar los datos en tu
        cuenta. Vuelve al panel para ver el progreso.
      </p>
    </div>
  );
}

// ─── Logo upload ───────────────────────────────────────────────────
// Reads a local image file, validates type + size, and stores it as a
// data: URL in the parent state. The backend's `Tenant.logo` field is
// just a `String?`, so a data URL works without any server changes.
// Recommended size: 512×512 px square, ≤ 500 KB, PNG/JPG/WebP.
const LOGO_MAX_BYTES = 500 * 1024;
const LOGO_RECOMMENDED_PX = 512;
const LOGO_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml";

function LogoUpload({
  value,
  onChange,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  function handleFile(file: File) {
    setError(null);
    setHint(null);
    if (!LOGO_ACCEPT.split(",").includes(file.type)) {
      setError("Formato no soportado. Usa PNG, JPG, WebP o SVG.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      const kb = Math.round(file.size / 1024);
      setError(`La imagen pesa ${kb} KB. El máximo es 500 KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      onChange(dataUrl);
      // Inspect dimensions for a soft recommendation (skip SVG which
      // has no intrinsic pixel size).
      if (file.type !== "image/svg+xml") {
        const img = new Image();
        img.onload = () => {
          if (img.width !== img.height) {
            setHint(
              `Tu imagen mide ${img.width}×${img.height} px. Se ve mejor si es cuadrada (${LOGO_RECOMMENDED_PX}×${LOGO_RECOMMENDED_PX}).`,
            );
          } else if (img.width < LOGO_RECOMMENDED_PX / 2) {
            setHint(
              `Tu imagen mide ${img.width}×${img.height} px. Se verá borrosa al ampliarla. Recomendado: ${LOGO_RECOMMENDED_PX}×${LOGO_RECOMMENDED_PX}.`,
            );
          }
        };
        img.src = dataUrl;
      }
    };
    reader.onerror = () => setError("No se pudo leer el archivo.");
    reader.readAsDataURL(file);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset so picking the same file again still fires onChange.
    e.target.value = "";
  }

  return (
    <div className={className}>
      <span className="block text-xs font-medium text-slate-700 mb-1">
        Logo del salón
        <span className="text-slate-400 ml-1 font-normal">(opcional, puedes añadirlo después)</span>
      </span>
      <div className="flex items-center gap-4">
        <div className="h-20 w-20 flex-shrink-0 rounded-full border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center">
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={value}
              alt="Vista previa del logo"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-xs text-slate-400 text-center px-1">
              Sin logo
            </span>
          )}
        </div>
        <div className="flex-1">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Upload className="h-4 w-4" />
            {value ? "Cambiar imagen" : "Subir imagen"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={LOGO_ACCEPT}
            onChange={onPick}
            className="hidden"
          />
          <p className="mt-1 text-xs text-slate-500">
            Recomendado: {LOGO_RECOMMENDED_PX}×{LOGO_RECOMMENDED_PX} px, formato
            cuadrado, ≤ 500 KB. PNG, JPG, WebP o SVG.
          </p>
          {hint && (
            <p className="mt-1 text-xs text-amber-700">{hint}</p>
          )}
          {error && (
            <p className="mt-1 text-xs text-red-600">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Field primitive ───────────────────────────────────────────────
function Field({
  label,
  value,
  onChange,
  required,
  type = "text",
  placeholder,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-xs font-medium text-slate-700 mb-1">
        {label}
        {required && <span className="text-red-500 ml-0.5">*</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-violet-500"
      />
    </label>
  );
}