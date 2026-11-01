"use client";
import { ImportLink } from "@/components/import-link";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import apiClient from "@/lib/api";
import type { Service } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Plus, Pencil, Trash2, Search, Filter } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";
import { formatEuros } from "../appointments/components/appointment-drawer.utils";
import {
  EMPTY_SERVICE_FORM,
  SERVICE_FORM_LIMITS,
  formToPayload,
  serviceToForm,
  type ServiceCategoryValue,
  type ServiceFormState,
  parseEuros,
} from "@/lib/service-form";
import { useTaxRegime } from "@/lib/use-tax-regime";
import { clientPriceHint } from "@/lib/prices-tax-example";


function ServicesPageContent() {
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const t = useTranslations();
  // Prices here are the catalogue as the salon writes it. When it writes
  // them without the tax, clients see them with it: the drawer says how much.
  const tax = useTaxRegime();

  const CATEGORIES = [
    { value: "hair", label: t("services.hair") },
    { value: "nails", label: t("services.nails") },
    { value: "facial", label: t("services.facial") },
    { value: "massage", label: t("services.massage") },
    { value: "body", label: t("services.body") },
    { value: "other", label: t("services.other") },
  ];

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "hair":
        return "bg-blue-100 text-blue-800";
      case "nails":
        return "bg-pink-100 text-pink-800";
      case "facial":
        return "bg-green-100 text-green-800";
      case "massage":
        return "bg-purple-100 text-purple-800";
      case "body":
        return "bg-orange-100 text-orange-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const [services, setServices] = useState<Service[]>([]);
  const [filteredServices, setFilteredServices] = useState<Service[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [isLoading, setIsLoading] = useState(true);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [toDelete, setToDelete] = useState<Service | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Check for ?new=true query parameter to open add service drawer
  useEffect(() => {
    if (searchParams?.get("new") === "true") {
      setIsDrawerOpen(true);
    }
  }, [searchParams]);

  // Numbers as typed: see lib/service-form.ts.
  const [formData, setFormData] = useState<ServiceFormState>(EMPTY_SERVICE_FORM);
  // "Las clientas verán 36,30 € (IVA incluido)", live as the price is typed.
  const clientPrice = clientPriceHint(parseEuros(formData.price), tax.serverRate, tax.pricesIncludeTax, tax.label);
  const setField = <K extends keyof ServiceFormState>(key: K, value: ServiceFormState[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    setFormError(null);
  };

  // Fetch services on mount
  useEffect(() => {
    fetchServices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filter services when search or category changes
  useEffect(() => {
    let filtered = services;

    if (searchTerm) {
      filtered = filtered.filter(
        (service) =>
          service.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          service.description?.toLowerCase().includes(searchTerm.toLowerCase()),
      );
    }

    if (categoryFilter !== "all") {
      filtered = filtered.filter(
        (service) => service.category === categoryFilter,
      );
    }

    setFilteredServices(filtered);
  }, [services, searchTerm, categoryFilter]);

  // Every failure says so. This page used to answer a failed request with
  // mock data or a local "optimistic" edit plus a success toast, so a salon
  // could create, edit or delete a service, be told it worked, and find it
  // gone on the next load.
  const reportFailure = (title: string, error: unknown) => {
    console.error(title, error);
    toast({
      title,
      description: error instanceof Error ? error.message : undefined,
      variant: "destructive",
    });
  };

  const fetchServices = async () => {
    try {
      setIsLoading(true);
      const data = await apiClient.getServices();
      setServices(data);
    } catch (error) {
      setServices([]);
      reportFailure(t("services.load_failed"), error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateNew = () => {
    setSelectedService(null);
    setIsEditing(false);
    setFormData(EMPTY_SERVICE_FORM);
    setFormError(null);
    setIsDrawerOpen(true);
  };

  const handleEdit = (service: Service) => {
    setSelectedService(service);
    setIsEditing(true);
    setFormData(serviceToForm(service));
    setFormError(null);
    setIsDrawerOpen(true);
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    setIsDeleting(true);
    try {
      // With appointments it is history: the server deactivates it
      // instead, and the reloaded list shows it inactive.
      const { deactivated } = await apiClient.deleteService(toDelete.id);
      toast({
        title: t(deactivated ? "services.service_deactivated" : "services.service_deleted"),
        description: t(
          deactivated
            ? "services.service_deactivated_history"
            : "services.service_deleted_success",
        ),
        variant: "default",
      });
      setToDelete(null);
      fetchServices();
    } catch (error) {
      reportFailure(t("services.delete_failed"), error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const checked = formToPayload(formData);
    if (!checked.ok) {
      setFormError(t(`services.${checked.error}`));
      return;
    }
    setIsSubmitting(true);

    try {
      if (isEditing && selectedService) {
        await apiClient.updateService(selectedService.id, checked.payload);
        toast({
          title: t("services.service_updated"),
          description: t("services.service_updated_success"),
          variant: "default",
        });
      } else {
        await apiClient.createService(checked.payload);
        toast({
          title: t("services.service_created"),
          description: t("services.service_created_success"),
          variant: "default",
        });
      }
      setIsDrawerOpen(false);
      fetchServices();
    } catch (error) {
      reportFailure(t("services.save_failed"), error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleServiceStatus = async (service: Service) => {
    try {
      await apiClient.updateService(service.id, {
        isActive: !service.isActive,
      });
      toast({
        title: t("services.status_updated"),
        description: service.isActive
          ? t("services.service_deactivated")
          : t("services.service_activated"),
        variant: "default",
      });
      fetchServices();
    } catch (error) {
      reportFailure(t("services.status_failed"), error);
    }
  };

  const inputClass =
    "w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent";

  const switchClass = (on: boolean) =>
    `relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
      on ? "bg-blue-600" : "bg-gray-200"
    }`;
  const knobClass = (on: boolean) =>
    `inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
      on ? "translate-x-6" : "translate-x-1"
    }`;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col gap-3 mb-8 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 truncate">
            {t("services.title")}
          </h1>
          <p className="text-gray-600 mt-1">{t("services.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ImportLink kind="services" />
          <Button onClick={handleCreateNew} className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            {t("services.add_service")}
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
        <div className="flex flex-wrap gap-4">
          <div className="flex-1 min-w-[200px]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder={t("services.search_services")}
                aria-label={t("services.search_services")}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-gray-400" />
            <select
              value={categoryFilter}
              aria-label={t("services.category")}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="all">{t("services.all_categories")}</option>
              {CATEGORIES.map((cat) => (
                <option key={cat.value} value={cat.value}>
                  {cat.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Services Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : filteredServices.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500">{t("services.no_services_found")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
          {filteredServices.map((service) => (
            <Card
              key={service.id}
              className={`hover:shadow-md transition-shadow ${
                !service.isActive ? "opacity-60" : ""
              }`}
            >
              <CardHeader className="flex flex-row items-start justify-between pb-2">
                <div className="flex-1">
                  <CardTitle className="text-lg font-semibold text-gray-900">
                    {service.name}
                  </CardTitle>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium mt-1 ${getCategoryColor(
                      service.category,
                    )}`}
                  >
                    {CATEGORIES.find((c) => c.value === service.category)
                      ?.label || service.category}
                  </span>
                  {!service.isActive && (
                    <span className="ml-1 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium mt-1 bg-gray-200 text-gray-700">
                      {t("services.inactive_badge")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleEdit(service)}
                    className="h-8 w-8"
                    aria-label={t("services.edit_tooltip", { name: service.name })}
                    title={t("services.edit_tooltip", { name: service.name })}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setToDelete(service)}
                    className="h-8 w-8 text-red-500 hover:text-red-700"
                    aria-label={t("services.delete_named", { name: service.name })}
                    title={t("services.delete_named", { name: service.name })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-600 mb-3 line-clamp-2">
                  {service.description || t("services.no_description")}
                </p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="text-lg font-bold text-gray-900">
                      {formatEuros(service.price)}
                    </div>
                    <div className="text-sm text-gray-500">
                      {service.duration} {t("services.minutes")}
                    </div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={service.isActive}
                    aria-label={t("services.toggle_active", { name: service.name })}
                    onClick={() => toggleServiceStatus(service)}
                    className={switchClass(service.isActive)}
                  >
                    <span className={knobClass(service.isActive)} />
                  </button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!toDelete}
        title={t("services.delete_service")}
        description={toDelete ? t("services.delete_service_confirm", { name: toDelete.name }) : undefined}
        confirmLabel={t("services.delete_tooltip")}
        cancelLabel={t("services.cancel")}
        destructive
        loading={isDeleting}
        onCancel={() => setToDelete(null)}
        onConfirm={confirmDelete}
      />

      {/* Drawer */}
      {isDrawerOpen && (
        <div className="fixed inset-0 z-50">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setIsDrawerOpen(false)}
          />
          {/* Drawer panel */}
          <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-xl overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-semibold text-gray-900">
                  {isEditing
                    ? t("services.edit_service")
                    : t("services.new_service")}
                </h2>
                <button
                  type="button"
                  onClick={() => setIsDrawerOpen(false)}
                  className="text-gray-400 hover:text-gray-600"
                  aria-label={t("services.cancel")}
                >
                  ✕
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="service-name" className="block text-sm font-medium text-gray-700 mb-1">
                    {t("services.service_name")} *
                  </label>
                  <input
                    id="service-name"
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setField("name", e.target.value)}
                    className={inputClass}
                    placeholder={t("services.placeholder_service_name")}
                  />
                </div>

                <div>
                  <label htmlFor="service-description" className="block text-sm font-medium text-gray-700 mb-1">
                    {t("services.description_label")}
                  </label>
                  <textarea
                    id="service-description"
                    value={formData.description}
                    onChange={(e) => setField("description", e.target.value)}
                    rows={3}
                    className={inputClass}
                    placeholder={t("services.placeholder_description")}
                  />
                </div>

                <div>
                  <label htmlFor="service-category" className="block text-sm font-medium text-gray-700 mb-1">
                    {t("services.category")} *
                  </label>
                  <select
                    id="service-category"
                    required
                    value={formData.category}
                    onChange={(e) => setField("category", e.target.value as ServiceCategoryValue)}
                    className={inputClass}
                  >
                    {CATEGORIES.map((cat) => (
                      <option key={cat.value} value={cat.value}>
                        {cat.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="service-duration" className="block text-sm font-medium text-gray-700 mb-1">
                      {t("services.duration_minutes")} *
                    </label>
                    <input
                      id="service-duration"
                      type="number"
                      required
                      min={SERVICE_FORM_LIMITS.durationMin}
                      max={SERVICE_FORM_LIMITS.durationMax}
                      step="1"
                      value={formData.duration}
                      onChange={(e) => setField("duration", e.target.value)}
                      className={inputClass}
                    />
                  </div>

                  <div>
                    <label htmlFor="service-price" className="block text-sm font-medium text-gray-700 mb-1">
                      {t("services.price_euros")} *
                    </label>
                    <input
                      id="service-price"
                      type="number"
                      required
                      min="0"
                      max={SERVICE_FORM_LIMITS.priceMax}
                      step="0.01"
                      value={formData.price}
                      onChange={(e) => setField("price", e.target.value)}
                      aria-describedby={clientPrice ? "service-price-hint" : undefined}
                      className={inputClass}
                    />
                    {clientPrice && (
                      <p id="service-price-hint" data-test="service-client-price" className="mt-1 text-xs text-gray-500">
                        {t(clientPrice.key, clientPrice.params)}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={formData.isActive}
                    aria-labelledby="service-active-label"
                    onClick={() => setField("isActive", !formData.isActive)}
                    className={switchClass(formData.isActive)}
                  >
                    <span className={knobClass(formData.isActive)} />
                  </button>
                  <span id="service-active-label" className="text-sm text-gray-700">
                    {t("services.active_label")}
                  </span>
                </div>

                <fieldset className="space-y-3 rounded-md border border-gray-200 p-4">
                  <legend className="px-1 text-sm font-semibold text-gray-900">
                    {t("services.online_section")}
                  </legend>

                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={formData.isOnlineBookable}
                      aria-labelledby="service-online-label"
                      aria-describedby="service-online-hint"
                      onClick={() => setField("isOnlineBookable", !formData.isOnlineBookable)}
                      className={switchClass(formData.isOnlineBookable)}
                    >
                      <span className={knobClass(formData.isOnlineBookable)} />
                    </button>
                    <div>
                      <span id="service-online-label" className="text-sm text-gray-700">
                        {t("services.online_bookable")}
                      </span>
                      <p id="service-online-hint" className="text-xs text-gray-500">
                        {t("services.online_bookable_hint")}
                      </p>
                    </div>
                  </div>

                  {formData.isOnlineBookable && (
                    <>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label htmlFor="service-min-advance" className="block text-sm font-medium text-gray-700 mb-1">
                            {t("services.min_advance_hours")}
                          </label>
                          <input
                            id="service-min-advance"
                            type="number"
                            min="0"
                            max={SERVICE_FORM_LIMITS.minAdvanceHoursMax}
                            step="1"
                            value={formData.minAdvanceBooking}
                            onChange={(e) => setField("minAdvanceBooking", e.target.value)}
                            className={inputClass}
                            aria-describedby="service-window-hint"
                          />
                        </div>
                        <div>
                          <label htmlFor="service-max-advance" className="block text-sm font-medium text-gray-700 mb-1">
                            {t("services.max_advance_days")}
                          </label>
                          <input
                            id="service-max-advance"
                            type="number"
                            min="1"
                            max={SERVICE_FORM_LIMITS.maxAdvanceDaysMax}
                            step="1"
                            value={formData.maxAdvanceBooking}
                            onChange={(e) => setField("maxAdvanceBooking", e.target.value)}
                            className={inputClass}
                            aria-describedby="service-window-hint"
                          />
                        </div>
                      </div>
                      <p id="service-window-hint" className="text-xs text-gray-500">
                        {t("services.booking_window_hint")}
                      </p>

                      <label className="flex items-start gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={formData.requiresApproval}
                          onChange={(e) => setField("requiresApproval", e.target.checked)}
                          aria-describedby="service-approval-hint"
                        />
                        <span>
                          {t("services.requires_approval")}
                          <span id="service-approval-hint" className="block text-xs text-gray-500">
                            {t("services.requires_approval_hint")}
                          </span>
                        </span>
                      </label>
                    </>
                  )}
                </fieldset>

                {formError && (
                  <p role="alert" className="text-sm text-red-600">
                    {formError}
                  </p>
                )}

                <div className="flex gap-3 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setIsDrawerOpen(false)}
                    className="flex-1"
                  >
                    {t("services.cancel")}
                  </Button>
                  <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="flex-1"
                  >
                    {isSubmitting
                      ? t("services.saving")
                      : isEditing
                        ? t("services.update")
                        : t("services.create")}
                  </Button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// useSearchParams() needs a Suspense boundary for the page to prerender
// (required since Next.js 14.1; 14.0 let it through).
export default function ServicesPage() {
  return (
    <Suspense fallback={null}>
      <ServicesPageContent />
    </Suspense>
  );
}
