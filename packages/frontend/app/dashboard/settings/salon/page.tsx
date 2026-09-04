"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import apiClient from "@/lib/api";
import { Loader2, Save, Upload } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";

const LOGO_MAX_BYTES = 500 * 1024;
const LOGO_RECOMMENDED_PX = 512;
const LOGO_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml";

/**
 * Salon identity page. Owns the Tenant's public-facing fields:
 *   - name, description
 *   - address (street, city, postalCode, state, country)
 *   - phone, logo
 *
 * Tax identifiers (NIF/CIF/NIE + régimen fiscal) live in
 * /dashboard/settings/fiscal since they only matter when Spanish
 * fiscal compliance is enabled.
 */
export default function SalonSettingsPage() {
  const t = useTranslations();
  const qc = useQueryClient();
  const tenant = useQuery({
    queryKey: ["auth", "tenant"],
    queryFn: () => apiClient.getTenant(),
  });

  const update = useMutation({
    mutationFn: (patch: Parameters<typeof apiClient.updateTenant>[0]) =>
      apiClient.updateTenant(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth", "tenant"] }),
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [street, setStreet] = useState("");
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [state, setState] = useState("");
  const [phone, setPhone] = useState("");
  const [logo, setLogo] = useState("");

  useEffect(() => {
    if (!tenant.data) return;
    const d = tenant.data as any;
    setName(d.name ?? "");
    setDescription(d.description ?? "");
    setStreet(d.street ?? "");
    setCity(d.city ?? "");
    setPostalCode(d.postalCode ?? "");
    setState(d.state ?? "");
    setPhone(d.phone ?? "");
    setLogo(d.logo ?? "");
  }, [tenant.data]);

  if (tenant.isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">
          {t("settings.salon.title")}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {t("settings.salon.subtitle")}
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({
            name: name.trim(),
            description: description.trim() || undefined,
            street: street.trim(),
            city: city.trim(),
            postalCode: postalCode.trim() || undefined,
            state: state.trim() || undefined,
            phone: phone.trim(),
            logo: logo.trim(),
          });
        }}
        className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm space-y-5"
      >
        <div>
          <label className="text-sm font-medium text-gray-900">
            {t("settings.salon.name")}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            required
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-900">
            {t("settings.salon.description")}
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className="text-sm font-medium text-gray-900">
              {t("settings.salon.street")}
            </label>
            <input
              type="text"
              value={street}
              onChange={(e) => setStreet(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-900">
              {t("settings.salon.city")}
            </label>
            <input
              type="text"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-900">
              {t("settings.salon.postalCode")}
            </label>
            <input
              type="text"
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-900">
              {t("settings.salon.state")}
            </label>
            <input
              type="text"
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-900">
              {t("settings.salon.phone")}
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              required
            />
          </div>
        </div>

        <LogoUploadField
          value={logo}
          onChange={setLogo}
          label={t("settings.salon.logo")}
        />

        <div className="flex items-center justify-end gap-3">
          {update.isSuccess && (
            <span className="text-xs text-green-600">
              {t("settings.saved")}
            </span>
          )}
          <button
            type="submit"
            disabled={update.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
          >
            {update.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t("settings.save_changes")}
          </button>
        </div>
      </form>
    </div>
  );
}

function LogoUploadField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
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
      if (file.type !== "image/svg+xml") {
        const img = new Image();
        img.onload = () => {
          if (img.width !== img.height) {
            setHint(
              `Tu imagen mide ${img.width}×${img.height} px. Se ve mejor si es cuadrada (${LOGO_RECOMMENDED_PX}×${LOGO_RECOMMENDED_PX}).`,
            );
          } else if (img.width < LOGO_RECOMMENDED_PX / 2) {
            setHint(
              `Tu imagen mide ${img.width}×${img.height} px. Se verá borrosa. Recomendado: ${LOGO_RECOMMENDED_PX}×${LOGO_RECOMMENDED_PX}.`,
            );
          }
        };
        img.src = dataUrl;
      }
    };
    reader.onerror = () => setError("No se pudo leer el archivo.");
    reader.readAsDataURL(file);
  }

  return (
    <div>
      <span className="block text-sm font-medium text-gray-900 mb-1">
        {label}
      </span>
      <div className="flex items-center gap-4">
        <div className="h-20 w-20 flex-shrink-0 rounded-full border border-gray-200 bg-gray-50 overflow-hidden flex items-center justify-center">
          {value ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={value}
              alt="Logo"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-xs text-gray-400 text-center px-1">
              Sin logo
            </span>
          )}
        </div>
        <div className="flex-1">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Upload className="h-4 w-4" />
            {value ? "Cambiar imagen" : "Subir imagen"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={LOGO_ACCEPT}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = "";
            }}
            className="hidden"
          />
          <p className="mt-1 text-xs text-gray-500">
            Recomendado: {LOGO_RECOMMENDED_PX}×{LOGO_RECOMMENDED_PX} px,
            cuadrado, ≤ 500 KB. PNG, JPG, WebP o SVG.
          </p>
          {hint && <p className="mt-1 text-xs text-amber-700">{hint}</p>}
          {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  );
}