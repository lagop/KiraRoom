"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import apiClient, {
  ClientAppointmentSummary,
  ClientCadence,
  ClientDetail,
  RebookingReminder,
  Service,
} from "@/lib/api";
import { Loader2, RefreshCcw, BellOff, ArrowLeft, AlertTriangle } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import { getCurrentUser } from "@/lib/utils";
import { isManager } from "@/lib/dashboard-nav";
import {
  clientStatusBadgeClass,
  formatClientDate,
  formatClientDay,
} from "@/lib/client-form";
import {
  appointmentTotalCents,
  formatCents,
} from "@/app/dashboard/appointments/components/appointment-drawer.utils";
import { ClientLoyaltyCard } from "@/components/loyalty/client-loyalty-card";
import { ClientMarketingCard } from "@/components/marketing/client-marketing-card";
import { ClientNoticesCard } from "@/components/notifications/client-notices-card";
import { ClientGdprCard } from "@/components/clients/client-gdpr-card";

/** Shown with the visit list when the server capped it (see the API). */
const HISTORY_LIMIT = 100;

const TAX_ID_TYPE_LABEL: Record<string, string> = {
  nif: "NIF",
  cif: "CIF",
  nie: "NIE",
  passport: "Pasaporte",
  other: "Documento",
};

// Next 14: `params` is a plain object. Unwrapping it with React's `use` is
// Next 15's promise form, and threw here.
export default function ClientDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const t = useTranslations();
  const { id } = params;
  const qc = useQueryClient();
  // Read after mount: the server has no token (see the dashboard header).
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, []);
  const manager = isManager(role);

  const client = useQuery<ClientDetail>({
    queryKey: ["clients", "detail", id],
    queryFn: () => apiClient.getClient(id),
    enabled: !!id,
    retry: false,
  });
  const services = useQuery<Service[]>({
    queryKey: ["services", "all"],
    queryFn: () => apiClient.getServices(),
  });
  const cadence = useQuery<ClientCadence | null>({
    queryKey: ["rebooking", "prediction", id],
    queryFn: () => apiClient.getRebookingPrediction(id),
    enabled: !!id,
  });
  const log = useQuery<RebookingReminder[]>({
    queryKey: ["rebooking", "log", id],
    queryFn: () => apiClient.getRebookingLog(id),
    enabled: !!id,
  });

  const recompute = useMutation({
    mutationFn: () => apiClient.recomputeClientCadence(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rebooking", "prediction", id] });
    },
  });
  const optOut = useMutation({
    mutationFn: () => apiClient.optOutClientRebooking(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rebooking", "prediction", id] });
    },
  });

  // Service id → name: the salon's catalogue, then the names on her visits
  // (a service removed since still has its name there).
  const serviceNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const appt of client.data?.appointments ?? []) {
      if (appt.service) names.set(appt.service.id, appt.service.name);
      for (const row of appt.services ?? []) {
        if (row.service) names.set(row.service.id, row.service.name);
      }
    }
    for (const s of services.data ?? []) names.set(s.id, s.name);
    return names;
  }, [client.data, services.data]);
  const serviceName = (serviceId: string | null | undefined) =>
    (serviceId && serviceNames.get(serviceId)) || t("clients.unknown");

  if (client.isLoading) {
    return (
      <div className="mx-auto flex max-w-4xl items-center gap-2 p-6 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  if (client.isError || !client.data) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <BackLink />
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {t("clients.load_failed")}
          {client.error instanceof Error && client.error.message ? `: ${client.error.message}` : ""}
        </div>
      </div>
    );
  }

  const c = client.data;
  const allergies = asList(c.allergies);
  const conditions = asList(c.medicalConditions);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <BackLink />

      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600">
            <span className="text-lg font-semibold text-white">
              {c.firstName.charAt(0)}
              {c.lastName.charAt(0)}
            </span>
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold text-gray-900">
              {c.firstName} {c.lastName}
            </h1>
            <p className="text-sm text-gray-500">
              {t("clients.client_since")} {formatClientDate(c.createdAt)}
            </p>
          </div>
        </div>
        <span
          className={`inline-flex self-start rounded-full px-2 py-1 text-xs font-medium sm:self-center ${clientStatusBadgeClass(c.status)}`}
        >
          {t(`clients.status_${c.status}`)}
        </span>
      </header>

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">
          {t("clients.contact_information")}
        </h2>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Field label={t("clients.email")} value={c.email} />
          <Field label={t("clients.phone")} value={c.phone} />
          <Field
            label={t("clients.tax_id")}
            value={c.taxId ? `${c.taxId}${c.taxIdType ? ` (${TAX_ID_TYPE_LABEL[c.taxIdType] ?? c.taxIdType})` : ""}` : null}
          />
          <Field label={t("clients.date_of_birth")} value={formatClientDay(c.dateOfBirth)} />
          <Field label={t("clients.gender")} value={c.gender ? t(`clients.${c.gender}`) : null} />
          <Field label={t("clients.last_visit")} value={formatClientDate(c.lastVisit)} />
        </dl>
        {c.notes && (
          <div className="mt-4 text-sm">
            <p className="text-gray-500">{t("clients.notes")}</p>
            <p className="mt-1 whitespace-pre-wrap text-gray-900">{c.notes}</p>
          </div>
        )}
        {(allergies.length > 0 || conditions.length > 0) && (
          <div className="mt-4 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="space-y-1">
              {allergies.length > 0 && (
                <p>
                  <strong>{t("clients.allergies")}:</strong> {allergies.join(", ")}
                </p>
              )}
              {conditions.length > 0 && (
                <p>
                  <strong>{t("clients.medical_conditions")}:</strong> {conditions.join(", ")}
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      <VisitHistory appointments={c.appointments ?? []} />

      <ClientLoyaltyCard clientId={id} />

      <ClientMarketingCard clientId={id} />

      <ClientNoticesCard clientId={id} />

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              {t("rebooking.client.predictionTitle")}
            </h2>
            {cadence.isLoading && (
              <div className="mt-3 flex items-center gap-2 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            )}
            {cadence.data?.optedOut && (
              <p className="mt-2 text-sm text-amber-700">
                {t("rebooking.client.optedOut")}
              </p>
            )}
            {cadence.data && !cadence.data.optedOut && (
              <RebookingSummary cadence={cadence.data} />
            )}
            {cadence.data &&
              !cadence.data.optedOut &&
              Object.keys(cadence.data.byService).length === 0 && (
                <p className="mt-2 text-sm text-gray-500">
                  {t("rebooking.client.noData", { minVisits: 3 })}
                </p>
              )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Recomputing is the owner's or an admin's (the API refuses staff). */}
            {manager && (
              <button
                type="button"
                disabled={recompute.isPending}
                onClick={() => recompute.mutate()}
                className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                {recompute.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCcw className="h-3 w-3" />
                )}
                {t("rebooking.client.recompute")}
              </button>
            )}
            {cadence.data && !cadence.data.optedOut && (
              <button
                type="button"
                disabled={optOut.isPending}
                onClick={() => optOut.mutate()}
                className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <BellOff className="h-3 w-3" />
                {t("rebooking.client.disable")}
              </button>
            )}
          </div>
        </div>

        {cadence.data && Object.keys(cadence.data.byService).length > 0 && (
          <div className="overflow-x-auto">
            <table className="mt-6 w-full min-w-[640px] text-sm">
            <thead className="text-xs text-gray-500">
              <tr>
                <th className="whitespace-nowrap text-left">{t("clients.service")}</th>
                <th className="whitespace-nowrap text-left">{t("rebooking.client.nextExpected")}</th>
                <th className="whitespace-nowrap text-left">{t("rebooking.client.interval")}</th>
                <th className="whitespace-nowrap text-left">{t("rebooking.client.lastReminder")}</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(cadence.data.byService).map(([svcId, s]) => {
                const reminder = cadence.data?.reminderSentFor.find(
                  (r) => r.serviceId === svcId,
                );
                return (
                  <tr key={svcId} className="border-t border-gray-100">
                    <td>{serviceName(svcId)}</td>
                    <td>
                      {new Date(s.nextExpectedAt).toLocaleDateString("es-ES")}
                    </td>
                    <td>
                      {s.avgDays}d ± {s.stdDevDays}d
                    </td>
                    <td>
                      {reminder
                        ? new Date(reminder.sentAt).toLocaleDateString("es-ES")
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">
          {t("clients.reminder_history")}
        </h2>
        {log.data && log.data.length > 0 ? (
          <ul className="mt-3 divide-y divide-gray-100">
            {log.data.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-2 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span>{r.serviceId ? serviceName(r.serviceId) : "—"}</span>
                <span className="text-xs text-gray-500">{t(`rebooking.status.${r.status}`)}</span>
                <span className="text-xs text-gray-400">
                  {r.sentAt
                    ? new Date(r.sentAt).toLocaleString("es-ES")
                    : new Date(r.scheduledAt).toLocaleString("es-ES")}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-gray-500">—</p>
        )}
      </section>

      {/* Her data-protection rights: the API answers owner / admin only. */}
      {manager && (
        <ClientGdprCard
          clientId={id}
          firstName={c.firstName}
          lastName={c.lastName}
          email={c.email}
          phone={c.phone}
        />
      )}
    </div>
  );
}

function BackLink() {
  const t = useTranslations();
  return (
    <Link
      href="/dashboard/clients"
      className="inline-flex items-center gap-1 text-sm text-violet-600 hover:underline"
    >
      <ArrowLeft className="h-4 w-4" />
      {t("clients.back_to_clients")}
    </Link>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-gray-500">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-gray-900">{value || "—"}</dd>
    </div>
  );
}

/** Allergies and conditions are a JSON list; tolerate anything else. */
function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter(Boolean) : [];
}

/** Her visits, most recent first, with what each one was charged. */
function VisitHistory({ appointments }: { appointments: ClientAppointmentSummary[] }) {
  const t = useTranslations();
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-gray-900">{t("clients.visit_history")}</h2>
      {appointments.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">{t("clients.no_history")}</p>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th className="whitespace-nowrap py-2 pr-3">{t("clients.date")}</th>
                  <th className="whitespace-nowrap py-2 pr-3">{t("clients.services")}</th>
                  <th className="whitespace-nowrap py-2 pr-3">{t("clients.status")}</th>
                  <th className="whitespace-nowrap py-2 pr-3 text-right">{t("clients.charged")}</th>
                  <th className="whitespace-nowrap py-2 text-right">{t("clients.paid")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {appointments.map((a) => {
                  const rows = a.services && a.services.length > 0 ? a.services : null;
                  const names = rows
                    ? rows.map((r) => r.service?.name).filter(Boolean).join(", ")
                    : a.service?.name;
                  const pro = rows?.[0]?.professional ?? a.professional;
                  return (
                    <tr key={a.id} className="align-top">
                      <td className="whitespace-nowrap py-2 pr-3">
                        {formatClientDay(a.scheduledDate)}
                        <span className="block text-xs text-gray-500">{a.scheduledTime}</span>
                      </td>
                      <td className="py-2 pr-3">
                        {names || t("clients.unknown")}
                        {pro && (
                          <span className="block text-xs text-gray-500">
                            {t("clients.with_professional", { name: `${pro.firstName} ${pro.lastName}` })}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${appointmentStatusClass(a.status)}`}>
                          {t(`appointments.status_${a.status}`)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3 text-right font-medium">
                        {/* totalAmount (cents), else the price (euros). */}
                        {formatCents(appointmentTotalCents({ totalAmount: a.totalAmount, price: a.price }))}
                      </td>
                      <td className="whitespace-nowrap py-2 text-right text-gray-600">
                        {formatCents(a.amountPaid)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {appointments.length >= HISTORY_LIMIT && (
            <p className="mt-2 text-xs text-gray-500">
              {t("clients.history_limit", { count: HISTORY_LIMIT })}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function appointmentStatusClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-green-100 text-green-800";
    case "pending":
      return "bg-yellow-100 text-yellow-800";
    case "cancelled":
    case "no_show":
      return "bg-red-100 text-red-800";
    default:
      return "bg-blue-100 text-blue-800";
  }
}

function RebookingSummary({ cadence }: { cadence: ClientCadence }) {
  const t = useTranslations();
  const nextAt = cadence.nextRecommendedReminderAt;
  return (
    <div className="mt-2 text-sm text-gray-700">
      {nextAt ? (
        <p>
          {t("rebooking.client.nextExpected")}:{" "}
          <strong>{new Date(nextAt).toLocaleDateString("es-ES")}</strong>
        </p>
      ) : (
        <p>—</p>
      )}
    </div>
  );
}
