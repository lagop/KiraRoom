"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  Building2,
  Check,
  Clock,
  Loader2,
  Lock,
  MapPin,
} from "lucide-react";
import apiClient from "@/lib/api";

type InviteContext = {
  email: string;
  tenantName: string;
  firstName: string | null;
  lastName: string | null;
  expiresAt: string;
};

const TIMEZONES = [
  "Europe/Madrid",
  "Europe/Lisbon",
  "Europe/Paris",
  "Europe/Berlin",
  "Atlantic/Canary",
  "America/Mexico_City",
  "America/Bogota",
  "America/Buenos_Aires",
];

export default function AcceptInvitePage() {
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [invite, setInvite] = useState<InviteContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Step 1 — password
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  // Step 2 — address
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("ES");
  const [phone, setPhone] = useState("");

  // Step 3 — timezone
  const [timezone, setTimezone] = useState("Europe/Madrid");

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    apiClient
      .getInvite(token)
      .then((data) => {
        setInvite(data);
        if (data.firstName) setFirstName(data.firstName);
        if (data.lastName) setLastName(data.lastName);
      })
      .catch((e) => {
        const msg =
          e?.response?.data?.message ||
          "Esta invitación no es válida, ha caducado o ya se ha utilizado.";
        setLoadError(typeof msg === "string" ? msg : JSON.stringify(msg));
      })
      .finally(() => setLoading(false));
  }, [token]);

  function nextFrom1() {
    if (password.length < 8) {
      setSubmitError("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (password !== confirmPassword) {
      setSubmitError("Las contraseñas no coinciden.");
      return;
    }
    setSubmitError(null);
    setStep(2);
  }

  function nextFrom2() {
    if (!street.trim() || !city.trim() || !postalCode.trim()) {
      setSubmitError("Calle, ciudad y código postal son obligatorios.");
      return;
    }
    setSubmitError(null);
    setStep(3);
  }

  async function submit() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await apiClient.acceptInvite(token, {
        password,
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        street: street.trim(),
        city: city.trim(),
        state: state.trim() || undefined,
        postalCode: postalCode.trim(),
        country,
        timezone,
        phone: phone.trim() || undefined,
      });
      if (res?.accessToken) {
        localStorage.setItem("kira_auth_token", res.accessToken);
        if (res.refreshToken) {
          localStorage.setItem("kira_refresh_token", res.refreshToken);
        }
      }
      setStep(4);
      // Redirect to the onboarding wizard after a short pause.
      setTimeout(() => router.push("/dashboard/onboarding"), 1500);
    } catch (e: any) {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        "No se pudo completar la invitación.";
      setSubmitError(typeof msg === "string" ? msg : JSON.stringify(msg));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <Centered>
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
        <p className="mt-3 text-slate-600">Validando invitación…</p>
      </Centered>
    );
  }

  if (loadError) {
    return (
      <Centered>
        <AlertCircle className="w-10 h-10 text-red-500" />
        <h1 className="text-xl font-semibold mt-3">Invitación no válida</h1>
        <p className="text-sm text-slate-600 mt-2 max-w-md text-center">
          {loadError}
        </p>
        <Link
          href="/login"
          className="mt-6 px-4 py-2 text-sm bg-slate-100 hover:bg-slate-200 rounded-md"
        >
          Ir al inicio de sesión
        </Link>
      </Centered>
    );
  }

  if (!invite) return null;

  const expiresAt = new Date(invite.expiresAt);
  const daysLeft = Math.max(
    0,
    Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
  );

  return (
    <main className="min-h-screen bg-slate-50 py-12 px-4">
      <div className="max-w-xl mx-auto">
        <header className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-indigo-600 rounded-xl mb-3">
            <Building2 className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold">Configura tu salón</h1>
          <p className="text-sm text-slate-600 mt-1">
            {invite.tenantName} · {invite.email}
          </p>
          <p className="text-xs text-slate-500 mt-1 inline-flex items-center gap-1">
            <Clock className="w-3 h-3" />
            Caduca en {daysLeft} día(s)
          </p>
        </header>

        <Stepper step={step} />

        <div className="mt-6 bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
          {step === 1 && (
            <Section icon={<Lock className="w-5 h-5" />} title="Crea tu contraseña">
              <p className="text-sm text-slate-600 mb-4">
                Mínimo 8 caracteres. Usa algo que recuerdes pero que
                otra persona no pueda adivinar.
              </p>
              <Field label="Nombre">
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  maxLength={80}
                  className={inputCls}
                  placeholder="María"
                />
              </Field>
              <Field label="Apellidos">
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  maxLength={80}
                  className={inputCls}
                  placeholder="García"
                />
              </Field>
              <Field label="Contraseña">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  className={inputCls}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Repite la contraseña">
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={8}
                  className={inputCls}
                  autoComplete="new-password"
                />
              </Field>
              {submitError && <ErrorMsg>{submitError}</ErrorMsg>}
              <Nav>
                <span />
                <button type="button" onClick={nextFrom1} className={primaryBtn}>
                  Continuar
                </button>
              </Nav>
            </Section>
          )}

          {step === 2 && (
            <Section icon={<MapPin className="w-5 h-5" />} title="Dirección del salón">
              <Field label="Calle y número">
                <input
                  value={street}
                  onChange={(e) => setStreet(e.target.value)}
                  maxLength={200}
                  className={inputCls}
                  placeholder="Calle Gran Vía 28"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Ciudad">
                  <input
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    maxLength={80}
                    className={inputCls}
                    placeholder="Madrid"
                  />
                </Field>
                <Field label="Provincia (opcional)">
                  <input
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    maxLength={80}
                    className={inputCls}
                    placeholder="Madrid"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Código postal">
                  <input
                    value={postalCode}
                    onChange={(e) => setPostalCode(e.target.value)}
                    maxLength={20}
                    className={inputCls}
                    placeholder="28013"
                  />
                </Field>
                <Field label="País (ISO)">
                  <input
                    value={country}
                    onChange={(e) => setCountry(e.target.value.toUpperCase())}
                    maxLength={2}
                    className={inputCls}
                    placeholder="ES"
                  />
                </Field>
              </div>
              <Field label="Teléfono del salón (opcional)">
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={inputCls}
                  placeholder="+34 600 000 000"
                />
              </Field>
              {submitError && <ErrorMsg>{submitError}</ErrorMsg>}
              <Nav>
                <button type="button" onClick={() => setStep(1)} className={ghostBtn}>
                  Atrás
                </button>
                <button type="button" onClick={nextFrom2} className={primaryBtn}>
                  Continuar
                </button>
              </Nav>
            </Section>
          )}

          {step === 3 && (
            <Section icon={<Clock className="w-5 h-5" />} title="Zona horaria">
              <p className="text-sm text-slate-600 mb-4">
                Usamos tu zona horaria para mostrar correctamente las
                citas, los recordatorios y los informes fiscales.
              </p>
              <Field label="Zona horaria">
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className={inputCls}
                >
                  {TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </Field>
              {submitError && <ErrorMsg>{submitError}</ErrorMsg>}
              <Nav>
                <button type="button" onClick={() => setStep(2)} className={ghostBtn}>
                  Atrás
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={submitting}
                  className={primaryBtn}
                >
                  {submitting ? (
                    <Loader2 className="w-4 h-4 animate-spin inline" />
                  ) : (
                    "Crear mi cuenta"
                  )}
                </button>
              </Nav>
            </Section>
          )}

          {step === 4 && (
            <div className="text-center py-8">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-emerald-100 rounded-full mb-3">
                <Check className="w-6 h-6 text-emerald-600" />
              </div>
              <h2 className="text-xl font-bold mb-2">¡Listo!</h2>
              <p className="text-sm text-slate-600">
                Te estamos llevando al configurador de tu salón…
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

const inputCls =
  "w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500";
const primaryBtn =
  "inline-flex items-center justify-center px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50";
const ghostBtn =
  "px-4 py-2 text-sm border border-slate-300 rounded-md hover:bg-slate-50";

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="text-center">{children}</div>
    </main>
  );
}

function Stepper({ step }: { step: number }) {
  const labels = ["Contraseña", "Dirección", "Zona horaria"];
  return (
    <ol className="flex items-center justify-between gap-2">
      {labels.map((label, i) => {
        const n = i + 1;
        const done = step > n;
        const active = step === n;
        return (
          <li key={label} className="flex-1 flex items-center">
            <div
              className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold ${
                done
                  ? "bg-emerald-600 text-white"
                  : active
                    ? "bg-indigo-600 text-white"
                    : "bg-slate-200 text-slate-600"
              }`}
            >
              {done ? <Check className="w-4 h-4" /> : n}
            </div>
            <span
              className={`ml-2 text-xs ${
                active ? "text-slate-900 font-medium" : "text-slate-500"
              }`}
            >
              {label}
            </span>
            {i < labels.length - 1 && (
              <div
                className={`flex-1 h-px mx-2 ${
                  done ? "bg-emerald-600" : "bg-slate-200"
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <span className="text-indigo-600">{icon}</span>
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-3">
      <span className="block text-sm font-medium text-slate-700 mb-1">{label}</span>
      {children}
    </label>
  );
}

function Nav({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-between mt-4">{children}</div>;
}

function ErrorMsg({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 p-3 mt-2 bg-red-50 border border-red-200 rounded text-red-800 text-sm">
      <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <span>{children}</span>
    </div>
  );
}