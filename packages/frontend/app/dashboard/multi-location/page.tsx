"use client";

import { useEffect, useState } from "react";
import apiClient from "../../../lib/api";
import { Plus, MapPin, Phone, Mail, Trash2, Edit2, BarChart3 } from "lucide-react";
import { PlanGate } from "@/components/billing/PlanGate";
import { useTranslations } from "@/lib/use-translation";

interface Location {
  id: string;
  name: string;
  slug: string;
  city?: string;
  street?: string;
  phone?: string;
  email?: string;
  isActive: boolean;
  _count?: { appointments: number; professionals: number };
}

interface LocationStats {
  locationId: string;
  windowDays: number;
  appointmentCount: number;
  revenue: number;
  activeProfessionals: number;
  totalClients: number;
}

const NUMBER_FMT = "es-ES";

export default function MultiLocationPage() {
  const t = useTranslations();
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const [stats, setStats] = useState<Record<string, LocationStats>>({});

  const load = async () => {
    try {
      const data = (await apiClient.request("/locations")) as Location[];
      setLocations(data);
    } catch {
      setLocations([]);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (locations === null) {
    return <div className="p-8 text-gray-500">{t("multiLocation.loading")}</div>;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">
            {t("multiLocation.title")}
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {t("multiLocation.subtitle")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
          >
            <Plus className="h-4 w-4" />
            {t("multiLocation.add")}
          </button>
        </div>
      </div>

      {showAdd && (
        <LocationForm
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            load();
          }}
          t={t}
        />
      )}
      {editing && (
        <LocationForm
          location={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          t={t}
        />
      )}

      <PlanGate feature="multi_location">
        {locations.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center">
            <MapPin className="mx-auto h-10 w-10 text-gray-400" />
            <h3 className="mt-3 text-sm font-semibold text-gray-900">
              {t("multiLocation.empty.title")}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t("multiLocation.empty.desc")}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {locations.map((loc) => (
              <LocationCard
                key={loc.id}
                location={loc}
                stats={stats[loc.id]}
                t={t}
                onStats={async () => {
                  try {
                    const s = (await apiClient.request(
                      `/locations/${loc.id}/stats`,
                    )) as LocationStats;
                    setStats((prev) => ({ ...prev, [loc.id]: s }));
                  } catch {
                    /* ignore */
                  }
                }}
                onEdit={() => setEditing(loc)}
                onDeleted={load}
              />
            ))}
          </div>
        )}
      </PlanGate>
    </div>
  );
}

function LocationCard({
  location,
  stats,
  t,
  onStats,
  onEdit,
  onDeleted,
}: {
  location: Location;
  stats?: LocationStats;
  t: (key: string, params?: Record<string, any>) => string;
  onStats: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const handleDelete = async () => {
    if (
      !confirm(t("multiLocation.card.deactivateConfirm", { name: location.name }))
    )
      return;
    try {
      await apiClient.request(`/locations/${location.id}`, {
        method: "DELETE",
      });
      onDeleted();
    } catch (e: any) {
      alert(e?.message || t("multiLocation.card.deactivateError"));
    }
  };
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            {location.name}
          </h3>
          <p className="text-xs text-gray-500">/{location.slug}</p>
        </div>
        <span
          className={
            "rounded px-2 py-0.5 text-xs " +
            (location.isActive
              ? "bg-emerald-100 text-emerald-700"
              : "bg-gray-100 text-gray-600")
          }
        >
          {location.isActive
            ? t("multiLocation.card.active")
            : t("multiLocation.card.inactive")}
        </span>
      </div>
      <div className="mt-3 space-y-1 text-sm text-gray-600">
        {location.city && (
          <p className="flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" />
            {location.street ? `${location.street}, ` : ""}
            {location.city}
          </p>
        )}
        {location.phone && (
          <p className="flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5" />
            {location.phone}
          </p>
        )}
        {location.email && (
          <p className="flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5" />
            {location.email}
          </p>
        )}
      </div>

      {stats && (
        <div className="mt-4 grid grid-cols-2 gap-2 rounded-md bg-gray-50 p-3 text-xs">
          <div>
            <p className="text-gray-500">{t("multiLocation.stats.appointments30d")}</p>
            <p className="font-semibold text-gray-900">
              {stats.appointmentCount}
            </p>
          </div>
          <div>
            <p className="text-gray-500">{t("multiLocation.stats.revenue30d")}</p>
            <p className="font-semibold text-gray-900">
              €{stats.revenue.toLocaleString(NUMBER_FMT)}
            </p>
          </div>
          <div>
            <p className="text-gray-500">{t("multiLocation.stats.professionals")}</p>
            <p className="font-semibold text-gray-900">
              {stats.activeProfessionals}
            </p>
          </div>
          <div>
            <p className="text-gray-500">{t("multiLocation.stats.clients")}</p>
            <p className="font-semibold text-gray-900">{stats.totalClients}</p>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={onStats}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          <BarChart3 className="h-3.5 w-3.5" />
          {stats
            ? t("multiLocation.card.refreshKpis")
            : t("multiLocation.card.viewKpis")}
        </button>
        <button
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
        >
          <Edit2 className="h-3.5 w-3.5" />
          {t("multiLocation.card.edit")}
        </button>
        <button
          onClick={handleDelete}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-red-100 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("multiLocation.card.deactivate")}
        </button>
      </div>
    </div>
  );
}

function LocationForm({
  location,
  onClose,
  onSaved,
  t,
}: {
  location?: Location;
  onClose: () => void;
  onSaved: () => void;
  t: (key: string) => string;
}) {
  const [form, setForm] = useState({
    name: location?.name ?? "",
    slug: location?.slug ?? "",
    city: location?.city ?? "",
    street: location?.street ?? "",
    phone: location?.phone ?? "",
    email: location?.email ?? "",
    isActive: location?.isActive ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const url = location ? `/locations/${location.id}` : "/locations";
      const method = location ? "PATCH" : "POST";
      await apiClient.request(url, {
        method,
        body: JSON.stringify(form),
      });
      onSaved();
    } catch (e: any) {
      setError(e?.message || t("multiLocation.form.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
      >
        <h3 className="text-lg font-semibold text-gray-900">
          {location
            ? t("multiLocation.form.edit")
            : t("multiLocation.form.new")}
        </h3>
        <div className="mt-4 space-y-3">
          <Field
            label={t("multiLocation.form.fields.name")}
            value={form.name}
            onChange={(v) => setForm((f) => ({ ...f, name: v }))}
            required
          />
          <Field
            label={t("multiLocation.form.fields.slug")}
            value={form.slug}
            onChange={(v) => setForm((f) => ({ ...f, slug: v }))}
          />
          <Field
            label={t("multiLocation.form.fields.street")}
            value={form.street}
            onChange={(v) => setForm((f) => ({ ...f, street: v }))}
          />
          <Field
            label={t("multiLocation.form.fields.city")}
            value={form.city}
            onChange={(v) => setForm((f) => ({ ...f, city: v }))}
          />
          <Field
            label={t("multiLocation.form.fields.phone")}
            value={form.phone}
            onChange={(v) => setForm((f) => ({ ...f, phone: v }))}
          />
          <Field
            label={t("multiLocation.form.fields.email")}
            value={form.email}
            onChange={(v) => setForm((f) => ({ ...f, email: v }))}
          />
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            {t("multiLocation.form.cancel")}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {saving
              ? t("multiLocation.form.saving")
              : t("multiLocation.form.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-700">{label}</span>
      <input
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
      />
    </label>
  );
}