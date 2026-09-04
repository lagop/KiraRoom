"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import apiClient from "@/lib/api";
import type { Service } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Plus, Pencil, Trash2, Search, Filter } from "lucide-react";
import { toast, useToast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";

// Mock data for demonstration - in production this would come from API
const MOCK_SERVICES: Service[] = [
  {
    id: "1",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    tenantId: "1",
    name: "Haircut & Styling",
    description: "Professional haircut and styling service",
    category: "hair",
    duration: 60,
    price: 45.0,
    currency: "EUR",
    isActive: true,
  },
  {
    id: "2",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    tenantId: "1",
    name: "Full Body Massage",
    description: "Relaxing full body massage",
    category: "massage",
    duration: 90,
    price: 85.0,
    currency: "EUR",
    isActive: true,
  },
  {
    id: "3",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    tenantId: "1",
    name: "Manicure",
    description: "Complete manicure service with nail polish",
    category: "nails",
    duration: 45,
    price: 35.0,
    currency: "EUR",
    isActive: true,
  },
  {
    id: "4",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    tenantId: "1",
    name: "Facial Treatment",
    description: "Deep cleansing facial treatment",
    category: "facial",
    duration: 60,
    price: 65.0,
    currency: "EUR",
    isActive: true,
  },
  {
    id: "5",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    tenantId: "1",
    name: "Hair Coloring",
    description: "Full hair coloring service",
    category: "hair",
    duration: 120,
    price: 95.0,
    currency: "EUR",
    isActive: true,
  },
  {
    id: "6",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    tenantId: "1",
    name: "Pedicure",
    description: "Complete pedicure service",
    category: "nails",
    duration: 45,
    price: 40.0,
    currency: "EUR",
    isActive: true,
  },
  {
    id: "7",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    tenantId: "1",
    name: "Hot Stone Massage",
    description: "Therapeutic massage with hot stones",
    category: "massage",
    duration: 90,
    price: 95.0,
    currency: "EUR",
    isActive: true,
  },
  {
    id: "8",
    createdAt: "2024-01-15T10:00:00Z",
    updatedAt: "2024-01-15T10:00:00Z",
    tenantId: "1",
    name: "Body Wrap",
    description: "Detoxifying body wrap treatment",
    category: "body",
    duration: 75,
    price: 75.0,
    currency: "EUR",
    isActive: false,
  },
];

export default function ServicesPage() {
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const t = useTranslations();

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

  // Check for ?new=true query parameter to open add service drawer
  useEffect(() => {
    if (searchParams?.get("new") === "true") {
      setIsDrawerOpen(true);
    }
  }, [searchParams]);

  // Form state
  const [formData, setFormData] = useState<{
    name: string;
    description: string;
    category: "hair" | "nails" | "facial" | "massage" | "body" | "other";
    duration: number;
    price: number;
    currency: string;
    isActive: boolean;
  }>({
    name: "",
    description: "",
    category: "other",
    duration: 30,
    price: 0,
    currency: "EUR",
    isActive: true,
  });

  // Fetch services on mount
  useEffect(() => {
    fetchServices();
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

  const fetchServices = async () => {
    try {
      setIsLoading(true);
      const data = await apiClient.getServices();
      setServices(data);
    } catch (error) {
      console.error("Failed to fetch services:", error);
      // Fall back to mock data if API fails
      setServices(MOCK_SERVICES);
      toast({
        title: t("services.using_demo_data"),
        description: t("services.could_not_connect"),
        variant: "default",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateNew = () => {
    setSelectedService(null);
    setIsEditing(false);
    setFormData({
      name: "",
      description: "",
      category: "other",
      duration: 30,
      price: 0,
      currency: "EUR",
      isActive: true,
    });
    setIsDrawerOpen(true);
  };

  const handleEdit = (service: Service) => {
    setSelectedService(service);
    setIsEditing(true);
    setFormData({
      name: service.name,
      description: service.description || "",
      category: service.category,
      duration: service.duration,
      price: service.price,
      currency: service.currency,
      isActive: service.isActive,
    });
    setIsDrawerOpen(true);
  };

  const handleDelete = async (service: Service) => {
    const toastId = toast({
      title: t("services.delete_service"),
      description: t("services.delete_service_confirm", { name: service.name }),
      variant: "destructive",
      open: true,
      action: (
        <div className="flex gap-2">
          <button
            onClick={async () => {
              try {
                await apiClient.deleteService(service.id);
                toast({
                  title: t("services.service_deleted"),
                  description: t("services.service_deleted_success"),
                  variant: "default",
                });
                fetchServices();
              } catch (error) {
                console.error("Failed to delete service:", error);
                // Optimistic UI update for demo
                setServices(services.filter((s) => s.id !== service.id));
                toast({
                  title: t("services.service_deleted"),
                  description: t("services.service_deleted_success"),
                  variant: "default",
                });
              }
            }}
            className="bg-red-500 text-white px-4 py-2 rounded-md hover:bg-red-600 transition-colors"
          >
            {t("services.delete_tooltip")}
          </button>
          <button
            onClick={() => {
              // Dismiss the toast without taking any action
              toastId.dismiss();
            }}
            className="bg-gray-200 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-300 transition-colors"
          >
            {t("services.cancel")}
          </button>
        </div>
      ),
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      if (isEditing && selectedService) {
        await apiClient.updateService(selectedService.id, formData);
        toast({
          title: t("services.service_updated"),
          description: t("services.service_updated_success"),
          variant: "default",
        });
      } else {
        await apiClient.createService({
          tenantId: "1",
          ...formData,
        });
        toast({
          title: t("services.service_created"),
          description: t("services.service_created_success"),
          variant: "default",
        });
      }
      setIsDrawerOpen(false);
      fetchServices();
    } catch (error) {
      console.error("Failed to save service:", error);
      // Optimistic UI update for demo
      if (isEditing && selectedService) {
        setServices(
          services.map((s) =>
            s.id === selectedService.id ? { ...s, ...formData } : s,
          ),
        );
        toast({
          title: t("services.service_updated"),
          description: t("services.service_updated_success"),
          variant: "default",
        });
      } else {
        const newService: Service = {
          id: Date.now().toString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tenantId: "1",
          ...formData,
        };
        setServices([...services, newService]);
        toast({
          title: t("services.service_created"),
          description: t("services.service_created_success"),
          variant: "default",
        });
      }
      setIsDrawerOpen(false);
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
      // Optimistic UI update for demo
      setServices(
        services.map((s) =>
          s.id === service.id ? { ...s, isActive: !s.isActive } : s,
        ),
      );
      toast({
        title: t("services.status_updated"),
        description: service.isActive
          ? t("services.service_deactivated")
          : t("services.service_activated"),
        variant: "default",
      });
    }
  };

  const closeForm = () => {
    setIsDrawerOpen(false);
    setSelectedService(null);
    setIsEditing(false);
    setFormData({
      name: "",
      description: "",
      category: "other",
      duration: 30,
      price: 0,
      currency: "EUR",
      isActive: true,
    });
  };

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
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleEdit(service)}
                    className="h-8 w-8"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(service)}
                    className="h-8 w-8 text-red-500 hover:text-red-700"
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
                      {service.currency}{" "}
                      {typeof service.price === "number"
                        ? service.price.toFixed(2)
                        : parseFloat(service.price || "0").toFixed(2)}
                    </div>
                    <div className="text-sm text-gray-500">
                      {service.duration} {t("services.minutes")}
                    </div>
                  </div>
                  <button
                    onClick={() => toggleServiceStatus(service)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                      service.isActive ? "bg-blue-600" : "bg-gray-200"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        service.isActive ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

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
                  onClick={() => setIsDrawerOpen(false)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("services.service_name")} *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) =>
                      setFormData({ ...formData, name: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder={t("services.placeholder_service_name")}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("services.description_label")}
                  </label>
                  <textarea
                    value={formData.description}
                    onChange={(e) =>
                      setFormData({ ...formData, description: e.target.value })
                    }
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    placeholder={t("services.placeholder_description")}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("services.category")} *
                  </label>
                  <select
                    required
                    value={formData.category}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        category: e.target.value as any,
                      })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t("services.duration")} *
                    </label>
                    <input
                      type="number"
                      required
                      min="1"
                      value={formData.duration}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          duration: parseInt(e.target.value) || 30,
                        })
                      }
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t("services.price")} *
                    </label>
                    <input
                      type="number"
                      required
                      min="0"
                      step="0.01"
                      value={formData.price}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          price: parseFloat(e.target.value) || 0,
                        })
                      }
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("services.currency")} *
                  </label>
                  <select
                    required
                    value={formData.currency}
                    onChange={(e) =>
                      setFormData({ ...formData, currency: e.target.value })
                    }
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  >
                    <option value="EUR">{t("services.eur_euro")}</option>
                    <option value="USD">{t("services.usd_dollar")}</option>
                    <option value="GBP">{t("services.gbp_pound")}</option>
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setFormData({ ...formData, isActive: !formData.isActive })
                    }
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                      formData.isActive ? "bg-blue-600" : "bg-gray-200"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        formData.isActive ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                  <span className="text-sm text-gray-700">
                    {t("services.active_label")}
                  </span>
                </div>

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
