"use client";

import { useState, useEffect, useMemo } from "react";
import {
  Bug,
  Search,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  X,
  ExternalLink,
  Mail,
} from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

interface BugReport {
  id: string;
  createdAt: string;
  subject: string;
  description: string;
  currentUrl: string | null;
  appVersion: string | null;
  email: string | null;
  context: Record<string, unknown> | null;
  status:
    | "open"
    | "triaged"
    | "in_progress"
    | "resolved"
    | "wont_fix"
    | "duplicate";
  resolution: string | null;
  resolvedAt: string | null;
  tenant: { id: string; name: string; slug: string } | null;
  author: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    role: string;
  } | null;
}

const STATUS_OPTIONS: BugReport["status"][] = [
  "open",
  "triaged",
  "in_progress",
  "resolved",
  "wont_fix",
  "duplicate",
];

const STATUS_STYLES: Record<BugReport["status"], string> = {
  open: "bg-red-100 text-red-800",
  triaged: "bg-amber-100 text-amber-800",
  in_progress: "bg-blue-100 text-blue-800",
  resolved: "bg-green-100 text-green-800",
  wont_fix: "bg-gray-200 text-gray-700",
  duplicate: "bg-slate-200 text-slate-700",
};

export default function SaasBugReportsPage() {
  const t = useTranslations();
  const [reports, setReports] = useState<BugReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [selected, setSelected] = useState<BugReport | null>(null);

  const fetchReports = async () => {
    try {
      setLoading(true);
      const result = await apiClient.getSaasBugReports({
        page,
        limit: 20,
        search: search || undefined,
        status: statusFilter || undefined,
      });
      setReports(result.data);
      setTotalPages(result.meta.totalPages);
      setTotal(result.meta.total);
      setError(null);
    } catch (err) {
      console.error("Error fetching bug reports:", err);
      setError("No se pudieron cargar los reportes");
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const s = await apiClient.getSaasBugReportStats();
      setStats(s);
    } catch (err) {
      console.error("Error fetching bug-report stats:", err);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  useEffect(() => {
    fetchReports();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter]);

  const openCount = stats?.open ?? 0;
  const totalCount = stats?.total ?? 0;

  const selectedIndex = useMemo(
    () => (selected ? reports.findIndex((r) => r.id === selected.id) : -1),
    [selected, reports],
  );

  const refreshSelected = async (id: string) => {
    try {
      const fresh = await apiClient.getSaasBugReport(id);
      setSelected(fresh);
      setReports((prev) => prev.map((r) => (r.id === id ? fresh : r)));
    } catch (err) {
      console.error("Error refreshing report:", err);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Bug className="w-6 h-6" />
            Reportes de bugs
          </h1>
          <p className="text-gray-500 mt-1">
            {total} reportes · {openCount} abiertos
          </p>
        </div>
      </div>

      {/* Status pills */}
      {stats && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => {
              setStatusFilter("");
              setPage(1);
            }}
            className={
              "px-3 py-1 rounded-full text-xs font-medium border " +
              (statusFilter === ""
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50")
            }
          >
            Todos ({totalCount})
          </button>
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => {
                setStatusFilter(s);
                setPage(1);
              }}
              className={
                "px-3 py-1 rounded-full text-xs font-medium border " +
                (statusFilter === s
                  ? "bg-slate-900 text-white border-slate-900"
                  : `${STATUS_STYLES[s]} border-transparent hover:opacity-80`)
              }
            >
              {s} ({stats[s] ?? 0})
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="flex items-center space-x-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            placeholder="Buscar por asunto, descripción o email…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") fetchReports();
            }}
            className="pl-10 pr-4 py-2 border border-gray-200 rounded-lg w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin w-8 h-8 border-4 border-slate-800 border-t-transparent rounded-full"></div>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <p className="text-red-600">{error}</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Asunto
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Salón
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Estado
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Reportante
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Fecha
                  </th>
                  <th className="px-6 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {reports.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-6 py-12 text-center text-gray-500"
                    >
                      No hay reportes.
                    </td>
                  </tr>
                ) : (
                  reports.map((r) => (
                    <tr
                      key={r.id}
                      className="hover:bg-gray-50 cursor-pointer"
                      onClick={() => setSelected(r)}
                    >
                      <td className="px-6 py-4">
                        <div className="text-sm font-medium text-gray-900 line-clamp-1">
                          {r.subject}
                        </div>
                        <div className="text-xs text-gray-500 line-clamp-1">
                          {r.description}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-700">
                        {r.tenant?.name ?? (
                          <span className="text-gray-400 italic">
                            anónimo
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLES[r.status]}`}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-700">
                        {r.author
                          ? `${r.author.firstName} ${r.author.lastName}`
                          : r.email ?? (
                              <span className="text-gray-400 italic">
                                anónimo
                              </span>
                            )}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <ChevronRight className="w-4 h-4 text-gray-400" />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-500">
                Mostrando {(page - 1) * 20 + 1}–
                {Math.min(page * 20, total)} de {total}
              </p>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setPage(page - 1)}
                  disabled={page === 1}
                  className="px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:opacity-50"
                >
                  Anterior
                </button>
                <span className="text-sm">
                  Página {page} de {totalPages}
                </span>
                <button
                  onClick={() => setPage(page + 1)}
                  disabled={page === totalPages}
                  className="px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:opacity-50"
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Detail drawer */}
      {selected && (
        <BugReportDrawer
          report={selected}
          onClose={() => setSelected(null)}
          onUpdated={() => refreshSelected(selected.id)}
          onNavigate={(dir) => {
            if (selectedIndex < 0) return;
            const next =
              reports[selectedIndex + (dir === "next" ? 1 : -1)];
            if (next) setSelected(next);
          }}
          hasPrev={selectedIndex > 0}
          hasNext={selectedIndex < reports.length - 1}
        />
      )}
    </div>
  );
}

function BugReportDrawer({
  report,
  onClose,
  onUpdated,
  onNavigate,
  hasPrev,
  hasNext,
}: {
  report: BugReport;
  onClose: () => void;
  onUpdated: () => Promise<void>;
  onNavigate: (dir: "prev" | "next") => void;
  hasPrev: boolean;
  hasNext: boolean;
}) {
  const [status, setStatus] = useState<BugReport["status"]>(report.status);
  const [resolution, setResolution] = useState(report.resolution ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setStatus(report.status);
    setResolution(report.resolution ?? "");
  }, [report]);

  const save = async () => {
    setSaving(true);
    try {
      await apiClient.updateSaasBugReport(report.id, {
        status,
        resolution: resolution || undefined,
      });
      await onUpdated();
    } catch (err) {
      console.error("Error saving report:", err);
      alert("No se pudo guardar el cambio");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/30 z-40 flex justify-end">
      <div className="w-full max-w-2xl bg-white h-full overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => onNavigate("prev")}
              disabled={!hasPrev}
              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
              title="Anterior"
            >
              <ChevronDown className="w-4 h-4 rotate-90" />
            </button>
            <button
              onClick={() => onNavigate("next")}
              disabled={!hasNext}
              className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
              title="Siguiente"
            >
              <ChevronDown className="w-4 h-4 -rotate-90" />
            </button>
            <h2 className="text-lg font-semibold text-gray-900 ml-2">
              Reporte de bug
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded hover:bg-gray-100"
            title="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div>
            <h3 className="text-xl font-semibold text-gray-900">
              {report.subject}
            </h3>
            <div className="text-xs text-gray-500 mt-1">
              {new Date(report.createdAt).toLocaleString()}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Salón">
              {report.tenant ? (
                <a
                  href={`/saas/tenants/${report.tenant.id}`}
                  className="text-blue-600 hover:underline inline-flex items-center gap-1"
                >
                  {report.tenant.name}
                  <ExternalLink className="w-3 h-3" />
                </a>
              ) : (
                <span className="text-gray-400 italic">Anónimo</span>
              )}
            </Field>
            <Field label="Reportante">
              {report.author ? (
                <span>
                  {report.author.firstName} {report.author.lastName}{" "}
                  <span className="text-gray-500">
                    ({report.author.role})
                  </span>
                </span>
              ) : report.email ? (
                <a
                  href={`mailto:${report.email}`}
                  className="text-blue-600 hover:underline inline-flex items-center gap-1"
                >
                  <Mail className="w-3 h-3" /> {report.email}
                </a>
              ) : (
                <span className="text-gray-400 italic">Anónimo</span>
              )}
            </Field>
            {report.currentUrl && (
              <Field label="URL">
                <a
                  href={report.currentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline inline-flex items-center gap-1 break-all"
                >
                  {report.currentUrl}
                  <ExternalLink className="w-3 h-3" />
                </a>
              </Field>
            )}
            {report.appVersion && (
              <Field label="Versión app">
                <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                  {report.appVersion}
                </code>
              </Field>
            )}
          </div>

          <div>
            <div className="text-xs font-medium text-gray-500 uppercase mb-1">
              Descripción
            </div>
            <pre className="text-sm whitespace-pre-wrap bg-gray-50 border border-gray-200 rounded-lg p-3 text-gray-800">
              {report.description}
            </pre>
          </div>

          {report.context &&
            Object.keys(report.context as object).length > 0 && (
              <details>
                <summary className="text-xs font-medium text-gray-500 uppercase cursor-pointer">
                  Contexto técnico
                </summary>
                <pre className="mt-2 text-xs whitespace-pre-wrap bg-gray-900 text-gray-100 rounded-lg p-3 overflow-x-auto">
                  {JSON.stringify(report.context, null, 2)}
                </pre>
              </details>
            )}

          <div className="border-t border-gray-200 pt-5 space-y-3">
            <div>
              <label className="text-xs font-medium text-gray-500 uppercase">
                Estado
              </label>
              <div className="mt-1 flex flex-wrap gap-2">
                {STATUS_OPTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatus(s)}
                    className={
                      "px-3 py-1 rounded-full text-xs font-medium border " +
                      (status === s
                        ? "bg-slate-900 text-white border-slate-900"
                        : `${STATUS_STYLES[s]} border-transparent hover:opacity-80`)
                    }
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-500 uppercase">
                Resolución / notas internas
              </label>
              <textarea
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                rows={3}
                placeholder="¿Qué se hizo? ¿Por qué wont_fix?"
                className="mt-1 w-full text-sm border border-gray-200 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {report.resolvedAt && (
              <p className="text-xs text-gray-500">
                Resuelto el {new Date(report.resolvedAt).toLocaleString()}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
              >
                {saving ? "Guardando…" : "Guardar cambios"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-gray-500 uppercase">{label}</div>
      <div className="text-sm text-gray-900 mt-0.5">{children}</div>
    </div>
  );
}