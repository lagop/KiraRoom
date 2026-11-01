"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  Tag,
  Plus,
  Percent,
  Euro,
  Calendar,
  Loader2,
  Lock,
} from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { errorMessage, isPlanBlocked } from "@/lib/email-campaigns";
import {
  CREATABLE_PROMOTION_TYPES,
  discountLabel,
  formatEuros,
  formatPromotionDate,
  promotionPayload,
  promotionTypeLabel,
} from "@/lib/promotions-format";

interface Promotion {
  id: string;
  name: string;
  description: string | null;
  code: string;
  type: "PERCENTAGE" | "FIXED" | "BUY_X_GET_Y";
  value: number;
  minOrderValue: number;
  maxUses: number | null;
  maxUsesPerClient: number | null;
  usedCount: number;
  startDate: string;
  endDate: string | null;
  isActive: boolean;
}

/** The end date is a calendar day and counts whole: it ends the day after. */
const hasEnded = (p: Promotion) =>
  !!p.endDate && Date.now() >= new Date(p.endDate).getTime() + 24 * 60 * 60 * 1000;

export default function PromotionsPage() {
  const t = useTranslations();
  const { toast } = useToast();
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  // The plan does not include promotions (403 FEATURE_NOT_IN_PLAN).
  const [planBlocked, setPlanBlocked] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingPromotion, setEditingPromotion] = useState<Promotion | null>(
    null,
  );
  // The promotion about to be deleted, confirmed in the panel's dialog.
  const [pendingDelete, setPendingDelete] = useState<Promotion | null>(null);
  const [deleting, setDeleting] = useState(false);

  const toastError = (title: string, error: unknown) =>
    toast({ title, description: errorMessage(error), variant: "destructive" });

  useEffect(() => {
    loadPromotions();
  }, []);

  const loadPromotions = async () => {
    try {
      const data = await apiClient.getPromotions();
      setPromotions(data);
      setPlanBlocked(false);
    } catch (error) {
      if (isPlanBlocked(error)) setPlanBlocked(true);
      else toastError("No se pudieron cargar las promociones", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const field = (name: string) => String(formData.get(name) ?? "");
    const editing = !!editingPromotion;
    // On an edit the code is not sent: it is the one clients already have.
    const data = promotionPayload(
      {
        name: field("name"),
        description: field("description"),
        code: field("code"),
        type: field("type"),
        value: field("value"),
        minOrderValue: field("minOrderValue"),
        maxUses: field("maxUses"),
        maxUsesPerClient: field("maxUsesPerClient"),
        startDate: field("startDate"),
        endDate: field("endDate"),
      },
      editing,
    );

    setSaving(true);
    try {
      if (editingPromotion) {
        await apiClient.updatePromotion(editingPromotion.id, data);
      } else {
        await apiClient.createPromotion(data);
      }
      await loadPromotions();
      setShowForm(false);
      setEditingPromotion(null);
      toast({ title: editing ? "Promoción guardada" : "Promoción creada" });
    } catch (error) {
      toastError("No se pudo guardar la promoción", error);
    } finally {
      setSaving(false);
    }
  };

  const performDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await apiClient.deletePromotion(pendingDelete.id);
      await loadPromotions();
      toast({ title: "Promoción eliminada" });
    } catch (error) {
      // 409 when an active campaign uses it: the server says which one.
      toastError("No se pudo eliminar la promoción", error);
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const handleToggleActive = async (promotion: Promotion) => {
    try {
      await apiClient.updatePromotion(promotion.id, {
        isActive: !promotion.isActive,
      });
      await loadPromotions();
    } catch (error) {
      toastError(
        promotion.isActive
          ? "No se pudo desactivar la promoción"
          : "No se pudo activar la promoción",
        error,
      );
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "PERCENTAGE":
        return <Percent className="w-4 h-4" />;
      case "FIXED":
        return <Euro className="w-4 h-4" />;
      default:
        return <Tag className="w-4 h-4" />;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">
            {t("promotions.title")}
          </h1>
          <p className="text-gray-600 mt-1">{t("promotions.subtitle")}</p>
        </div>
        {!planBlocked && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => {
                setEditingPromotion(null);
                setShowForm(true);
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md flex items-center gap-2"
            >
              <Plus className="w-4 h-4" /> {t("promotions.new_promotion")}
            </button>
          </div>
        )}
      </div>

      {planBlocked ? (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-6">
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
            <div className="space-y-2">
              <h2 className="font-semibold text-gray-900">
                {t("promotions.plan_blocked_title")}
              </h2>
              <p className="text-sm text-gray-700">
                {t("promotions.plan_blocked_body")}
              </p>
              <Link
                href="/dashboard/billing"
                className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                {t("promotions.plan_blocked_cta")}
              </Link>
            </div>
          </div>
        </div>
      ) : promotions.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-12 text-center">
          <Tag className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">
            {t("promotions.no_promotions")}
          </h3>
          <p className="text-gray-500 mb-4">
            {t("promotions.no_promotions_description")}
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md"
          >
            {t("promotions.create_promotion")}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {promotions.map((promotion) => {
            const ended = hasEnded(promotion);
            const live = promotion.isActive && !ended;
            return (
              <div key={promotion.id} className="bg-white rounded-lg shadow p-6">
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-2">
                    <div
                      className={`p-2 rounded-lg ${live ? "bg-green-100" : "bg-gray-100"}`}
                    >
                      {getTypeIcon(promotion.type)}
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-900">
                        {promotion.name}
                      </h3>
                      <code className="text-sm bg-gray-100 px-2 py-0.5 rounded">
                        {promotion.code}
                      </code>
                    </div>
                  </div>
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      live
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-gray-800"
                    }`}
                  >
                    {ended
                      ? t("promotions.expired")
                      : promotion.isActive
                        ? t("promotions.active")
                        : t("promotions.inactive")}
                  </span>
                </div>

                {promotion.description && (
                  <p className="text-sm text-gray-500 mb-4">
                    {promotion.description}
                  </p>
                )}

                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <p className="text-xs text-gray-500">
                      {t("promotions.discount")}
                    </p>
                    <p className="font-medium">
                      {discountLabel(promotion.type, promotion.value)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">
                      {t("promotions.min_order")}
                    </p>
                    <p className="font-medium">
                      {formatEuros(promotion.minOrderValue)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">
                      {t("promotions.uses")}
                    </p>
                    <p className="font-medium">
                      {promotion.usedCount}
                      {promotion.maxUses ? ` / ${promotion.maxUses}` : ""}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">
                      {t("promotions.type")}
                    </p>
                    <p className="font-medium">
                      {promotionTypeLabel(promotion.type)}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 text-xs text-gray-500 mb-4">
                  <Calendar className="w-3 h-3" />
                  <span>
                    {formatPromotionDate(promotion.startDate)}
                    {promotion.endDate &&
                      ` – ${formatPromotionDate(promotion.endDate)}`}
                  </span>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => handleToggleActive(promotion)}
                    className={`text-sm font-medium ${promotion.isActive ? "text-red-600 hover:text-red-800" : "text-green-600 hover:text-green-800"}`}
                  >
                    {promotion.isActive
                      ? t("promotions.deactivate")
                      : t("promotions.activate")}
                  </button>
                  <button
                    onClick={() => {
                      setEditingPromotion(promotion);
                      setShowForm(true);
                    }}
                    className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                  >
                    {t("promotions.edit")}
                  </button>
                  <button
                    onClick={() => setPendingDelete(promotion)}
                    className="text-red-600 hover:text-red-800 text-sm font-medium"
                  >
                    {t("promotions.delete")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create/Edit Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-semibold mb-4">
              {editingPromotion
                ? t("promotions.edit_promotion")
                : t("promotions.create_promotion_title")}
            </h2>
            <form onSubmit={handleSubmit}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t("promotions.promotion_name")}
                  </label>
                  <input
                    name="name"
                    required
                    defaultValue={editingPromotion?.name}
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t("promotions.description")}
                  </label>
                  <textarea
                    name="description"
                    defaultValue={editingPromotion?.description || ""}
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t("promotions.discount_code")}
                  </label>
                  <input
                    name="code"
                    required
                    readOnly={!!editingPromotion}
                    defaultValue={editingPromotion?.code}
                    className={`mt-1 w-full px-3 py-2 border border-gray-300 rounded-md uppercase ${
                      editingPromotion ? "bg-gray-100 text-gray-600" : ""
                    }`}
                    placeholder={t("promotions.code_placeholder")}
                  />
                  {editingPromotion && (
                    <p className="mt-1 text-xs text-gray-500">
                      {t("promotions.code_locked")}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("promotions.type")}
                    </label>
                    <select
                      name="type"
                      defaultValue={
                        CREATABLE_PROMOTION_TYPES.some(
                          (o) => o.value === editingPromotion?.type,
                        )
                          ? editingPromotion?.type
                          : "PERCENTAGE"
                      }
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                    >
                      {CREATABLE_PROMOTION_TYPES.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.value === "PERCENTAGE"
                            ? t("promotions.percentage")
                            : t("promotions.fixed_amount")}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("promotions.value")}
                    </label>
                    <input
                      name="value"
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      defaultValue={editingPromotion?.value}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("promotions.min_order")}
                    </label>
                    <input
                      name="minOrderValue"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue={editingPromotion?.minOrderValue || 0}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("promotions.max_uses")}
                    </label>
                    <input
                      name="maxUses"
                      type="number"
                      min="1"
                      defaultValue={editingPromotion?.maxUses || ""}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                      placeholder={t("promotions.unlimited")}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("promotions.max_per_client")}
                    </label>
                    <input
                      name="maxUsesPerClient"
                      type="number"
                      min="1"
                      defaultValue={editingPromotion?.maxUsesPerClient || ""}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                      placeholder={t("promotions.unlimited")}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("promotions.end_date")}
                    </label>
                    <input
                      name="endDate"
                      type="date"
                      defaultValue={
                        editingPromotion?.endDate?.split("T")[0] || ""
                      }
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t("promotions.start_date")}
                  </label>
                  <input
                    name="startDate"
                    type="date"
                    required
                    defaultValue={
                      editingPromotion?.startDate?.split("T")[0] ||
                      new Date().toISOString().split("T")[0]
                    }
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(false);
                    setEditingPromotion(null);
                  }}
                  className="px-4 py-2 border border-gray-300 rounded-md"
                >
                  {t("promotions.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md disabled:opacity-60"
                >
                  {editingPromotion
                    ? t("promotions.update")
                    : t("promotions.create")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={t("promotions.delete_confirm")}
        description={pendingDelete?.name}
        confirmLabel={t("promotions.delete_cta")}
        cancelLabel={t("common.cancel")}
        destructive
        loading={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={performDelete}
      />
    </div>
  );
}
