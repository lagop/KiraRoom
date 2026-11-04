"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import apiClient, { type SaasAuditLogRow } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { auditActionKey, auditPersonLabel } from "@/lib/audit-log-view";

const PAGE_SIZE = 50;
const input =
  "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500";

interface Filters {
  tenant: string;
  actor: string;
  action: string;
  from: string;
  to: string;
}
const EMPTY: Filters = { tenant: "", actor: "", action: "", from: "", to: "" };

/**
 * Audit 8, C9: the audit log, read-only. Every console action that changes
 * something writes a row (salons created, edited, suspended, deleted or
 * anonymised; add-ons and credits; platform settings; invitations), as do the
 * support sessions -- in which the actor is the platform owner, "en nombre de"
 * the salon's owner (C4) -- and some salon actions.
 */
export default function AuditLogPage() {
  const t = useTranslations();
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<SaasAuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [actions, setActions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const actionLabel = (action: string) => {
    const key = auditActionKey(action);
    const label = t(key);
    return label === key ? action : label;
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getSaasAuditLogs({ ...filters, page, limit: PAGE_SIZE });
      setRows(res.data);
      setTotal(res.meta.total);
      setTotalPages(res.meta.totalPages);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("saas.audit.load_failed"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // Initial tenant filter from the address (?tenant=...), e.g. from a salon's page.
    const q = new URLSearchParams(window.location.search).get("tenant");
    if (q) {
      setDraft((d) => ({ ...d, tenant: q }));
      setFilters((f) => ({ ...f, tenant: q }));
    }
    apiClient
      .getSaasAuditLogActions()
      .then((r) => setActions(r.data))
      .catch(() => setActions([]));
  }, []);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setFilters(draft);
  };

  const clear = () => {
    setDraft(EMPTY);
    setFilters(EMPTY);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <History className="w-7 h-7 text-gray-400 shrink-0" aria-hidden />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t("saas.audit.title")}</h1>
          <p className="text-gray-500 mt-1">{t("saas.audit.subtitle")}</p>
        </div>
      </div>

      <form onSubmit={apply} className="bg-white rounded-xl border border-gray-200 p-4 grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
        <label className="md:col-span-2 text-sm text-gray-700">
          {t("saas.audit.filter_salon")}
          <input
            className={input}
            value={draft.tenant}
            placeholder={t("saas.audit.filter_salon_placeholder")}
            onChange={(e) => setDraft({ ...draft, tenant: e.target.value })}
          />
        </label>
        <label className="md:col-span-2 text-sm text-gray-700">
          {t("saas.audit.filter_actor")}
          <input
            className={input}
            value={draft.actor}
            placeholder={t("saas.audit.filter_actor_placeholder")}
            onChange={(e) => setDraft({ ...draft, actor: e.target.value })}
          />
        </label>
        <label className="md:col-span-2 text-sm text-gray-700">
          {t("saas.audit.filter_action")}
          <select className={input} value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
            <option value="">{t("saas.audit.all_actions")}</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {actionLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="md:col-span-2 text-sm text-gray-700">
          {t("saas.audit.filter_from")}
          <input type="date" className={input} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
        </label>
        <label className="md:col-span-2 text-sm text-gray-700">
          {t("saas.audit.filter_to")}
          <input type="date" className={input} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
        </label>
        <div className="md:col-span-2 flex gap-2">
          <button type="submit" className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700">
            {t("saas.audit.apply")}
          </button>
          <button type="button" onClick={clear} className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">
            {t("saas.audit.clear")}
          </button>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-3 font-medium">{t("saas.audit.col_when")}</th>
              <th className="px-4 py-3 font-medium">{t("saas.audit.col_action")}</th>
              <th className="px-4 py-3 font-medium">{t("saas.audit.col_actor")}</th>
              <th className="px-4 py-3 font-medium">{t("saas.audit.col_salon")}</th>
              <th className="px-4 py-3 font-medium sr-only">{t("saas.audit.col_details")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                  {t("saas.audit.loading")}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                  {t("saas.audit.empty")}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <Fragment key={r.id}>
                  <tr className="align-top">
                    <td className="px-4 py-3 whitespace-nowrap text-gray-700">
                      {new Date(r.createdAt).toLocaleString("es-ES")}
                    </td>
                    <td className="px-4 py-3 text-gray-900">
                      <div>{actionLabel(r.action)}</div>
                      <div className="text-xs text-gray-400 font-mono">{r.action}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-700">
                      <div>{auditPersonLabel(r.actor)}</div>
                      {r.onBehalfOf && (
                        <div className="text-xs text-red-700">
                          {t("saas.audit.on_behalf_of", { name: auditPersonLabel(r.onBehalfOf) })}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{r.tenant?.name ?? (r.tenantId ? r.tenantId : "—")}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        className="text-indigo-600 hover:underline text-xs"
                        aria-expanded={open === r.id}
                        onClick={() => setOpen(open === r.id ? null : r.id)}
                      >
                        {open === r.id ? t("saas.audit.hide_details") : t("saas.audit.show_details")}
                      </button>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={5} className="px-4 pb-4">
                        <pre className="bg-gray-50 rounded-lg p-3 text-xs text-gray-700 overflow-x-auto whitespace-pre-wrap break-all">
                          {JSON.stringify(r.metadata ?? {}, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-gray-600">
        <span>{t("saas.audit.total", { total })}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="p-2 rounded-lg border border-gray-300 disabled:opacity-40"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label={t("saas.audit.previous")}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span>{t("saas.audit.page_of", { page, pages: totalPages })}</span>
          <button
            type="button"
            className="p-2 rounded-lg border border-gray-300 disabled:opacity-40"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => p + 1)}
            aria-label={t("saas.audit.next")}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
