"use client";

import { useState } from "react";
import { FlaskConical } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";

/**
 * On a salon's console page: whether it is one of our own salons (audit 8
 * D11). Internal salons are left out of the platform figures and alerts.
 * Each change is confirmed and audit-logged by the server.
 */
export function InternalSalonCard({
  tenantId,
  name,
  isInternal,
  onChange,
}: {
  tenantId: string;
  name: string;
  isInternal: boolean;
  onChange: (isInternal: boolean) => void;
}) {
  const t = useTranslations();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const next = !isInternal;

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiClient.setSaasTenantInternal(tenantId, next);
      onChange(res.isInternal);
      toast({ title: t(res.isInternal ? "saas.internal_salon.saved_on" : "saas.internal_salon.saved_off") });
      setConfirming(false);
    } catch (err) {
      console.error("Error changing the internal flag:", err);
      toast({ title: t("saas.internal_salon.failed"), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`rounded-xl border p-4 text-sm ${
        isInternal ? "border-violet-200 bg-violet-50 text-violet-900" : "border-gray-200 bg-white text-gray-700"
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <FlaskConical className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">{t("saas.internal_salon.title")}</p>
            <p>{t(isInternal ? "saas.internal_salon.on" : "saas.internal_salon.off")}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white px-4 py-2 text-gray-700 transition-colors hover:bg-gray-50"
        >
          {t(isInternal ? "saas.internal_salon.unmark" : "saas.internal_salon.mark")}
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={t(next ? "saas.internal_salon.confirm_mark" : "saas.internal_salon.confirm_unmark")}
        description={t(next ? "saas.internal_salon.confirm_mark_body" : "saas.internal_salon.confirm_unmark_body", {
          name,
        })}
        confirmLabel={t(next ? "saas.internal_salon.mark" : "saas.internal_salon.unmark")}
        cancelLabel={t("common.cancel")}
        loading={saving}
        onCancel={() => setConfirming(false)}
        onConfirm={save}
      />
    </div>
  );
}
