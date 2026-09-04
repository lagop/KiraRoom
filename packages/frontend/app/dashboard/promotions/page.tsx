"use client";

import { useState, useEffect } from "react";
import {
  Tag,
  Plus,
  Trash2,
  Edit,
  Percent,
  Euro,
  Gift,
  Calendar,
  CheckCircle,
  XCircle,
  Loader2,
} from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

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

export default function PromotionsPage() {
  const t = useTranslations();
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingPromotion, setEditingPromotion] = useState<Promotion | null>(
    null,
  );
  const [tenantId, setTenantId] = useState<string>("");

  useEffect(() => {
    const token = localStorage.getItem("kira_auth_token");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        setTenantId(payload.tenantId);
        loadPromotions(payload.tenantId);
      } catch (e) {
        console.error("Failed to decode token:", e);
      }
    }
  }, []);

  const loadPromotions = async (tenantId: string) => {
    try {
      setLoading(true);
      const data = await apiClient.getPromotions();
      setPromotions(data);
    } catch (error) {
      console.error("Failed to load promotions:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    const data = {
      name: formData.get("name"),
      description: formData.get("description"),
      code: formData.get("code"),
      type: formData.get("type"),
      value: parseFloat(formData.get("value") as string),
      minOrderValue: parseFloat(formData.get("minOrderValue") as string) || 0,
      maxUses: formData.get("maxUses")
        ? parseInt(formData.get("maxUses") as string)
        : null,
      maxUsesPerClient: formData.get("maxUsesPerClient")
        ? parseInt(formData.get("maxUsesPerClient") as string)
        : null,
      startDate: formData.get("startDate"),
      endDate: formData.get("endDate") || null,
    };

    try {
      if (editingPromotion) {
        await apiClient.updatePromotion(editingPromotion.id, data);
      } else {
        await apiClient.createPromotion(data);
      }
      await loadPromotions(tenantId);
      setShowForm(false);
      setEditingPromotion(null);
    } catch (error) {
      console.error("Failed to save promotion:", error);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm(t("promotions.delete_confirm"))) return;

    try {
      await apiClient.deletePromotion(id);
      await loadPromotions(tenantId);
    } catch (error) {
      console.error("Failed to delete promotion:", error);
    }
  };

  const handleToggleActive = async (promotion: Promotion) => {
    try {
      await apiClient.updatePromotion(promotion.id, {
        isActive: !promotion.isActive,
      });
      await loadPromotions(tenantId);
    } catch (error) {
      console.error("Failed to toggle promotion:", error);
    }
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "PERCENTAGE":
        return <Percent className="w-4 h-4" />;
      case "FIXED":
        return <Euro className="w-4 h-4" />;
      case "BUY_X_GET_Y":
        return <Gift className="w-4 h-4" />;
      default:
        return <Tag className="w-4 h-4" />;
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case "PERCENTAGE":
        return t("promotions.percentage");
      case "FIXED":
        return t("promotions.fixed_amount");
      case "BUY_X_GET_Y":
        return t("promotions.buy_x_get_y");
      default:
        return type;
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
          <p className="text-gray-600 mt-1">{t("promotions.description")}</p>
        </div>
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
      </div>

      {promotions.length === 0 ? (
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
          {promotions.map((promotion) => (
            <div key={promotion.id} className="bg-white rounded-lg shadow p-6">
              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center gap-2">
                  <div
                    className={`p-2 rounded-lg ${promotion.isActive ? "bg-green-100" : "bg-gray-100"}`}
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
                    promotion.isActive
                      ? "bg-green-100 text-green-800"
                      : "bg-gray-100 text-gray-800"
                  }`}
                >
                  {promotion.isActive
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
                    {promotion.type === "PERCENTAGE"
                      ? `${promotion.value}%`
                      : `€${promotion.value}`}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">
                    {t("promotions.min_order")}
                  </p>
                  <p className="font-medium">€{promotion.minOrderValue}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">
                    {t("promotions.uses")}
                  </p>
                  <p className="font-medium">
                    {promotion.usedCount}
                    {promotion.maxUses && ` / ${promotion.maxUses}`}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">
                    {t("promotions.type")}
                  </p>
                  <p className="font-medium">{getTypeLabel(promotion.type)}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 text-xs text-gray-500 mb-4">
                <Calendar className="w-3 h-3" />
                <span>
                  {formatDate(promotion.startDate)}
                  {promotion.endDate && ` - ${formatDate(promotion.endDate)}`}
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
                  onClick={() => handleDelete(promotion.id)}
                  className="text-red-600 hover:text-red-800 text-sm font-medium"
                >
                  {t("promotions.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create/Edit Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
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
                    defaultValue={editingPromotion?.code}
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md uppercase"
                    placeholder={t("promotions.code_placeholder")}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("promotions.type")}
                    </label>
                    <select
                      name="type"
                      defaultValue={editingPromotion?.type || "PERCENTAGE"}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                    >
                      <option value="PERCENTAGE">
                        {t("promotions.percentage")}
                      </option>
                      <option value="FIXED">
                        {t("promotions.fixed_amount")}
                      </option>
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
                  className="px-4 py-2 bg-blue-600 text-white rounded-md"
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
    </div>
  );
}
