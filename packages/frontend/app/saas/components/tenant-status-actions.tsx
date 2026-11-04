"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Ban, Gift, Unlock } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import {
  COURTESY_MAX_DAYS,
  courtesyUntilIso,
  courtesyUntilProblem,
  dateInputValue,
  formatDateEs,
  isReadOnlyStatus,
  tenantActions,
  type TenantAction,
  type TenantActionState,
} from "@/lib/saas-tenant";

export interface StatusTenant extends TenantActionState {
  id: string;
  name: string;
  plan: string;
  deletionRequestedAt?: string | null;
  courtesyUntil?: string | null;
}

const PLANS = ["esencial", "pro", "empresa"] as const;

const BUTTON_CLASS: Record<TenantAction, string> = {
  suspend: "border-yellow-200 text-yellow-700 hover:bg-yellow-50",
  courtesy: "border-indigo-200 text-indigo-700 hover:bg-indigo-50",
  block: "border-red-200 text-red-700 hover:bg-red-50",
  unblock: "border-indigo-200 text-indigo-700 hover:bg-indigo-50",
};

const ICON: Record<TenantAction, typeof AlertTriangle> = {
  suspend: AlertTriangle,
  courtesy: Gift,
  block: Ban,
  unblock: Unlock,
};

/** The console's status buttons for a salon (audit 8 D4, D6): Suspender, Cortesía, Bloquear / Desbloquear. */
export function TenantStatusButtons({
  tenant,
  onAsk,
  compact = false,
}: {
  tenant: StatusTenant;
  onAsk: (action: TenantAction) => void;
  /** Icon-only, for the salons list. */
  compact?: boolean;
}) {
  const t = useTranslations();
  return (
    <>
      {tenantActions(tenant).map((action) => {
        const Icon = ICON[action];
        const label = t(`saas.console.action_${action}`);
        return compact ? (
          <button
            key={action}
            onClick={() => onAsk(action)}
            className={`p-2 rounded-lg text-gray-400 ${BUTTON_CLASS[action]}`}
            title={label}
            aria-label={label}
          >
            <Icon className="w-4 h-4" />
          </button>
        ) : (
          <button
            key={action}
            onClick={() => onAsk(action)}
            className={`inline-flex items-center px-4 py-2 border rounded-lg transition-colors ${BUTTON_CLASS[action]}`}
          >
            <Icon className="w-4 h-4 mr-2" />
            {label}
          </button>
        );
      })}
    </>
  );
}

/** "Bloqueado" and "Cortesía hasta …" next to the status. */
export function TenantStatusExtraBadges({ tenant }: { tenant: StatusTenant }) {
  const t = useTranslations();
  return (
    <>
      {tenant.blockedAt && (
        <span
          className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800"
          title={t("saas.console.blocked_badge_title", { date: formatDateEs(tenant.blockedAt, true) })}
        >
          {t("saas.console.blocked_badge")}
        </span>
      )}
      {tenant.courtesyUntil && (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
          {t("saas.console.courtesy_badge", { date: formatDateEs(tenant.courtesyUntil) })}
        </span>
      )}
    </>
  );
}

/**
 * The confirmation of each status button, with what it does in plain
 * Spanish; a failure keeps the dialog open with a toast (Stripe can fail,
 * and then nothing changed).
 */
export function TenantStatusDialog({
  tenant,
  action,
  onClose,
  onDone,
}: {
  tenant: StatusTenant | null;
  action: TenantAction | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState("pro");
  const [until, setUntil] = useState("");
  const [cancelDeletion, setCancelDeletion] = useState(false);

  useEffect(() => {
    if (!tenant || !action) return;
    setReason("");
    setCancelDeletion(false);
    setPlan((PLANS as readonly string[]).includes(tenant.plan) ? tenant.plan : "pro");
    setUntil(dateInputValue(new Date(), 30));
  }, [tenant, action]);

  if (!tenant || !action) {
    return <ConfirmDialog open={false} title="" onCancel={onClose} onConfirm={() => undefined} />;
  }

  const untilProblem = action === "courtesy" ? courtesyUntilProblem(until) : null;
  const needsDeletionChoice =
    action === "courtesy" && isReadOnlyStatus(tenant.subscriptionStatus) && !!tenant.deletionRequestedAt;

  const perform = async () => {
    setBusy(true);
    try {
      if (action === "suspend") await apiClient.suspendSaasTenant(tenant.id);
      if (action === "block") await apiClient.blockSaasTenant(tenant.id, reason.trim());
      if (action === "unblock") await apiClient.unblockSaasTenant(tenant.id);
      if (action === "courtesy") {
        await apiClient.courtesySaasTenant(tenant.id, {
          plan,
          until: courtesyUntilIso(until) ?? "",
          ...(needsDeletionChoice && cancelDeletion ? { cancelDeletion: true } : {}),
        });
      }
      toast({ title: t(`saas.console.${action}_ok`) });
      onClose();
      onDone();
    } catch (err) {
      console.error(`Error on ${action}:`, err);
      toast({ title: t(`saas.console.${action}_failed`), description: (err as Error)?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const today = dateInputValue(new Date(), 1);
  const maxDay = dateInputValue(new Date(), COURTESY_MAX_DAYS - 1);
  const description = (
    <div className="space-y-3">
      <p>{t(`saas.console.${action}_desc`)}</p>
      {action === "block" && (
        <label className="block">
          <span className="block text-sm font-medium text-gray-700 mb-1">{t("saas.console.block_reason")}</span>
          <textarea
            value={reason}
            maxLength={500}
            rows={3}
            onChange={(e) => setReason(e.target.value)}
            className="w-full px-3 py-2 border border-gray-200 rounded-lg"
          />
        </label>
      )}
      {action === "courtesy" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-sm font-medium text-gray-700 mb-1">{t("saas.console.plan")}</span>
            <select value={plan} onChange={(e) => setPlan(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-lg">
              {PLANS.map((p) => (
                <option key={p} value={p}>
                  {t(`saas.plan_${p}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-gray-700 mb-1">{t("saas.console.courtesy_until")}</span>
            <input
              type="date"
              required
              min={today}
              max={maxDay}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg"
            />
          </label>
          {untilProblem && <p className="sm:col-span-2 text-sm text-red-700">{t(`saas.console.courtesy_until_${untilProblem}`)}</p>}
        </div>
      )}
      {needsDeletionChoice && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-amber-900">
          <p>{t("saas.console.pending_deletion_warning", { date: formatDateEs(tenant.deletionRequestedAt) })}</p>
          <label className="mt-2 flex items-center gap-2">
            <input type="checkbox" checked={cancelDeletion} onChange={(e) => setCancelDeletion(e.target.checked)} />
            {t("saas.console.cancel_deletion_checkbox")}
          </label>
        </div>
      )}
    </div>
  );

  return (
    <ConfirmDialog
      open
      title={t(`saas.console.${action}_title`, { name: tenant.name })}
      description={description}
      confirmLabel={t(`saas.console.action_${action}`)}
      cancelLabel={t("common.cancel")}
      destructive={action === "suspend" || action === "block"}
      loading={busy}
      confirmDisabled={
        (action === "block" && !reason.trim()) || !!untilProblem || (needsDeletionChoice && !cancelDeletion)
      }
      onCancel={onClose}
      onConfirm={perform}
    />
  );
}
