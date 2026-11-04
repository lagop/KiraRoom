"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Copy, Mail, Plus, RefreshCw, XCircle } from "lucide-react";
import apiClient, { type SaasTenantInvite } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { formatDateEs, inviteCanResend, inviteCanRevoke } from "@/lib/saas-tenant";

const STATUSES = ["pending", "accepted", "expired", "revoked"] as const;

const STATUS_CLASS: Record<string, string> = {
  pending: "bg-blue-100 text-blue-800",
  accepted: "bg-indigo-100 text-indigo-800",
  expired: "bg-gray-100 text-gray-700",
  revoked: "bg-red-100 text-red-800",
};

/**
 * The console's invites (audit 8 T15): who was invited, whether they
 * accepted, and resend (a fresh link, also for expired ones) or revoke.
 * A resend says whether the email really went out; if not, the new link is
 * shown to copy.
 */
export default function TenantInvitesPage() {
  const t = useTranslations();
  const { toast } = useToast();
  const [invites, setInvites] = useState<SaasTenantInvite[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<SaasTenantInvite | null>(null);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setInvites(await apiClient.listTenantInvites(status ? { status } : undefined));
    } catch (err) {
      console.error("Error loading invites:", err);
      setError(t("saas.console.invites_failed_load"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const resend = async (invite: SaasTenantInvite) => {
    setBusyId(invite.id);
    setLink(null);
    try {
      const res = await apiClient.resendTenantInvite(invite.id);
      if (res.emailSent === false) {
        toast({
          title: t("saas.console.invite_not_sent", { email: invite.email }),
          variant: "destructive",
        });
        if (res.magicLink) setLink({ email: invite.email, url: res.magicLink });
      } else {
        toast({ title: t("saas.console.invite_sent_ok", { email: invite.email }) });
      }
      await load();
    } catch (err) {
      toast({
        title: t("saas.console.invite_failed"),
        description: (err as Error)?.message,
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const performRevoke = async () => {
    if (!pendingRevoke) return;
    setBusyId(pendingRevoke.id);
    try {
      await apiClient.revokeTenantInvite(pendingRevoke.id);
      toast({ title: t("saas.console.invite_revoked_ok") });
      setPendingRevoke(null);
      await load();
    } catch (err) {
      toast({
        title: t("saas.console.invite_failed"),
        description: (err as Error)?.message,
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable: the link stays visible to copy by hand */
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:space-x-4 min-w-0">
          <Link
            href="/saas/tenants"
            aria-label={t("saas.console.back_to_salons")}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors self-start sm:self-auto"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">{t("saas.console.invites_title")}</h1>
            <p className="text-gray-500 mt-1">{t("saas.console.invites_desc")}</p>
          </div>
        </div>
        <Link
          href="/saas/tenants/invite"
          className="inline-flex items-center px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors self-start sm:self-auto"
        >
          <Plus className="w-4 h-4 mr-2" />
          {t("saas.console.invite_new")}
        </Link>
      </div>

      <div className="flex items-center gap-2">
        <label htmlFor="invite-status" className="sr-only">
          {t("saas.console.invite_status")}
        </label>
        <select
          id="invite-status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">{t("saas.console.all_statuses")}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`saas.console.invite_status_${s}`)}
            </option>
          ))}
        </select>
      </div>

      {link && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">
          <p className="mb-2">{t("saas.console.invite_not_sent", { email: link.email })}</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={link.url}
              className="flex-1 px-3 py-2 text-xs font-mono bg-white border border-amber-300 rounded"
            />
            <button
              type="button"
              onClick={copyLink}
              className="inline-flex items-center gap-1 px-3 py-2 text-sm bg-amber-600 text-white rounded-md hover:bg-amber-700"
            >
              <Copy className="w-4 h-4" />
              {copied ? t("saas.console.copied") : t("saas.console.copy")}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <div className="animate-spin w-8 h-8 border-4 border-slate-800 border-t-transparent rounded-full"></div>
          </div>
        ) : error ? (
          <p role="alert" className="p-6 text-red-700">
            {error}
          </p>
        ) : invites.length === 0 ? (
          <p className="p-6 text-gray-500">{t("saas.console.invites_empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{t("saas.console.invite_salon_name")}</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{t("saas.console.invite_email")}</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{t("saas.console.invite_status")}</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{t("saas.console.invite_created")}</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">{t("saas.console.invite_expires")}</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">
                    <span className="sr-only">{t("saas.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {invites.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-4 py-3 text-gray-900">{inv.tenantName}</td>
                    <td className="px-4 py-3 text-gray-700 break-all">{inv.email}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[inv.status] ?? "bg-gray-100 text-gray-800"}`}
                      >
                        {t(`saas.console.invite_status_${inv.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{formatDateEs(inv.createdAt)}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {inv.status === "accepted" ? formatDateEs(inv.acceptedAt) : formatDateEs(inv.expiresAt, true)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {inviteCanResend(inv.status) && (
                          <button
                            type="button"
                            onClick={() => resend(inv)}
                            disabled={busyId === inv.id}
                            className="inline-flex items-center px-3 py-1.5 border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            {busyId === inv.id ? (
                              <RefreshCw className="w-4 h-4 mr-1 animate-spin" />
                            ) : (
                              <Mail className="w-4 h-4 mr-1" />
                            )}
                            {t("saas.console.invite_resend")}
                          </button>
                        )}
                        {inviteCanRevoke(inv.status) && (
                          <button
                            type="button"
                            onClick={() => setPendingRevoke(inv)}
                            disabled={busyId === inv.id}
                            className="inline-flex items-center px-3 py-1.5 border border-red-200 rounded-lg text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            <XCircle className="w-4 h-4 mr-1" />
                            {t("saas.console.invite_revoke")}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!pendingRevoke}
        title={pendingRevoke ? t("saas.console.invite_revoke_title", { email: pendingRevoke.email }) : ""}
        description={t("saas.console.invite_revoke_desc")}
        confirmLabel={t("saas.console.invite_revoke")}
        cancelLabel={t("common.cancel")}
        destructive
        loading={!!pendingRevoke && busyId === pendingRevoke.id}
        onCancel={() => setPendingRevoke(null)}
        onConfirm={performRevoke}
      />
    </div>
  );
}
