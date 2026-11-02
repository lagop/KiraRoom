"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import apiClient from "../../../lib/api";
import { Plus, MapPin, Phone, Mail, Trash2, Edit2, BarChart3 } from "lucide-react";
import { PlanGate } from "@/components/billing/PlanGate";
import { useFeatureAccess } from "@/hooks/useFeatureAccess";
import { getCurrentUser } from "@/lib/utils";
import { useTranslations } from "@/lib/use-translation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { formatCents, formatRate } from "@/lib/analytics-format";
import { ConsolidatedReport } from "./consolidated-report";
import { deactivationNotice, upcomingAppointmentsAt } from "@/lib/location-deactivation";

type T = (key: string, params?: Record<string, any>) => string;

/** The confirmation's text about the appointments still to come there. */
function noticeText(t: T, upcoming: number | null): string | undefined {
  const notice = deactivationNotice(upcoming);
  return notice ? t(notice.key, notice.params) : undefined;
}

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
  /** Cents. */
  revenue: number;
  occupancy?: { rate: number | null };
  activeProfessionals: number;
  totalClients: number;
}

export default function MultiLocationPage() {
  const t = useTranslations();
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Location | null>(null);
  const [stats, setStats] = useState<Record<string, LocationStats>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  // Creating, editing and the KPIs are Empresa; the list and closing a
  // location are not (a salon that left Empresa can still close one).
  const { enabled: multiLocation, loading: planLoading } = useFeatureAccess("multi_location");
  // DELETE /locations/:id is owner-only. Read after mount (localStorage).
  const [isOwner, setIsOwner] = useState(false);
  useEffect(() => {
    setIsOwner(getCurrentUser()?.role === "owner");
  }, []);

  const load = async () => {
    try {
      const data = (await apiClient.request("/locations")) as Location[];
      setLocations(data);
      setLoadError(null);
    } catch (e: any) {
      // It used to show as "you have no locations yet".
      setLoadError(e?.message || "Error");
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

  // Left Empresa with locations still on file: the list stays, read-only but closable.
  const downgraded = !planLoading && !multiLocation;

  const activeCount = locations.filter((l) => l.isActive).length;

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
        {/* Creating a location is Empresa: on other plans the button 403ed. */}
        <PlanGate feature="multi_location" fallback={null}>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => setShowAdd(true)}
              className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
            >
              <Plus className="h-4 w-4" />
              {t("multiLocation.add")}
            </button>
          </div>
        </PlanGate>
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

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {t("multiLocation.loadError")}: {loadError}
        </div>
      )}

      {downgraded && locations.length === 0 && !loadError && <PlanGate feature="multi_location">{null}</PlanGate>}

      {downgraded && locations.length > 0 && (
        <div className="space-y-3">
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            {t("multiLocation.downgraded")}
          </p>
          <PlanGate feature="multi_location">{null}</PlanGate>
        </div>
      )}

      {loadError ? null : locations.length === 0 ? (
        !downgraded && (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center">
            <MapPin className="mx-auto h-10 w-10 text-gray-400" />
            <h3 className="mt-3 text-sm font-semibold text-gray-900">
              {t("multiLocation.empty.title")}
            </h3>
            <p className="mt-1 text-sm text-gray-500">
              {t("multiLocation.empty.desc")}
            </p>
          </div>
        )
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
              canManage={multiLocation}
              canDeactivate={isOwner}
            />
          ))}
        </div>
      )}

      {/* Per-location comparison: only meaningful with several active
          locations (Empresa itself works from one). */}
      {activeCount >= 2 ? (
        <PlanGate feature="consolidated_reports">
          <ConsolidatedReport t={t} />
        </PlanGate>
      ) : (
        activeCount === 1 && (
          <p className="text-sm text-gray-500">
            {t("multiLocation.consolidated.needsTwo")}
          </p>
        )
      )}
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
  canManage,
  canDeactivate,
}: {
  location: Location;
  stats?: LocationStats;
  t: T;
  onStats: () => void;
  onEdit: () => void;
  onDeleted: () => void;
  /** Empresa: edit and KPIs. */
  canManage: boolean;
  /** The owner (DELETE is owner-only), on any plan. */
  canDeactivate: boolean;
}) {
  const { toast } = useToast();
  // Deactivating is confirmed in the panel's dialog.
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [checking, setChecking] = useState(false);
  const [upcoming, setUpcoming] = useState<number | null>(null);
  const askDeactivate = async () => {
    setChecking(true);
    setUpcoming(await upcomingAppointmentsAt(location.id));
    setChecking(false);
    setConfirmDeactivate(true);
  };
  const performDeactivate = async () => {
    setDeactivating(true);
    try {
      await apiClient.request(`/locations/${location.id}`, {
        method: "DELETE",
      });
      onDeleted();
    } catch (e: any) {
      toast({
        title: t("multiLocation.card.deactivateError"),
        description: e?.message,
        variant: "destructive",
      });
    } finally {
      setDeactivating(false);
      setConfirmDeactivate(false);
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
              {formatCents(stats.revenue)}
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
          <div>
            <p className="text-gray-500">{t("multiLocation.consolidated.occupancy30d")}</p>
            <p className="font-semibold text-gray-900">
              {stats.occupancy?.rate == null
                ? t("multiLocation.consolidated.noSchedule")
                : formatRate(stats.occupancy.rate)}
            </p>
          </div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        {canManage && (
          <>
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
          </>
        )}
        {location.isActive && canDeactivate && (
          <button
            onClick={askDeactivate}
            disabled={checking}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-red-100 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("multiLocation.card.deactivate")}
          </button>
        )}
      </div>

      <ConfirmDialog
        open={confirmDeactivate}
        title={t("multiLocation.card.deactivateConfirm", { name: location.name })}
        description={noticeText(t, upcoming)}
        confirmLabel={t("multiLocation.card.deactivateCta")}
        cancelLabel={t("common.cancel")}
        destructive
        loading={deactivating}
        onCancel={() => setConfirmDeactivate(false)}
        onConfirm={performDeactivate}
      />
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
  t: T;
}) {
  const { toast } = useToast();
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
  // Empresa at its paid locations: the owner adds one in Facturación (B8).
  const [atLocationLimit, setAtLocationLimit] = useState(false);
  // Switching a location off from the form asks first, with its upcoming appointments.
  const [confirmOff, setConfirmOff] = useState<{ upcoming: number | null } | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const url = location ? `/locations/${location.id}` : "/locations";
      const method = location ? "PATCH" : "POST";
      // A new location starts active; only an existing one sends the switch.
      const { isActive, ...fields } = form;
      await apiClient.request(url, {
        method,
        body: JSON.stringify(location ? { ...fields, isActive } : fields),
      });
      if (location && isActive !== location.isActive) {
        toast({
          title: isActive ? t("multiLocation.form.reactivated") : t("multiLocation.form.deactivated"),
        });
      }
      onSaved();
    } catch (e: any) {
      setError(e?.message || t("multiLocation.form.saveError"));
      setAtLocationLimit(e?.code === "LOCATION_LIMIT_REACHED");
    } finally {
      setSaving(false);
      setConfirmOff(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (location?.isActive && !form.isActive) {
      setSaving(true);
      const upcoming = await upcomingAppointmentsAt(location.id);
      setSaving(false);
      setConfirmOff({ upcoming });
      return;
    }
    await save();
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
          {location && (
            <label className="flex items-start gap-3 pt-1">
              <input
                type="checkbox"
                role="switch"
                aria-checked={form.isActive}
                checked={form.isActive}
                onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
              />
              <span>
                <span className="block text-sm font-medium text-gray-900">
                  {t("multiLocation.form.fields.isActive")}
                </span>
                <span className="block text-xs text-gray-500">{t("multiLocation.form.isActiveHint")}</span>
              </span>
            </label>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {error && atLocationLimit && getCurrentUser()?.role === "owner" && (
          <Link href="/dashboard/billing" className="mt-1 inline-block text-sm font-medium text-violet-700 underline">
            {t("multiLocation.form.addLocationInBilling")}
          </Link>
        )}
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
      <ConfirmDialog
        open={confirmOff !== null}
        title={t("multiLocation.card.deactivateConfirm", { name: location?.name ?? form.name })}
        description={confirmOff ? noticeText(t, confirmOff.upcoming) : undefined}
        confirmLabel={t("multiLocation.card.deactivateCta")}
        cancelLabel={t("common.cancel")}
        destructive
        loading={saving}
        onCancel={() => setConfirmOff(null)}
        onConfirm={save}
      />
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