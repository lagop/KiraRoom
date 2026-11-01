"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import apiClient from "@/lib/api";
import { Card } from "@/src/components/ui/Card";
import { Button } from "@/src/components/ui/Button";
import { Input } from "@/src/components/ui/Input";
import { Plus, Pencil, Trash2, Power } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useTranslations } from "@/lib/use-translation";
import { PanelAccessBlock } from "@/src/components/team/panel-access";
import type { PanelAccess } from "@/lib/panel-access";
import {
  commissionRateFieldValue,
  commissionRateForCreate,
  commissionRateForUpdate,
} from "@/lib/commission-rate-field";

// Local type definitions
interface Service {
  id: string;
  name: string;
  category: string;
}

interface Professional {
  id: string;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  profileImage?: string;
  bio?: string;
  specialties: string[];
  position?: string;
  /** Percent; Prisma's Decimal arrives as a string. None: the salon's default applies. */
  commissionRate?: number | string | null;
  hireDate?: string;
  isActive: boolean;
  services?: {
    serviceId: string;
    service: {
      id: string;
      name: string;
      category: string;
    };
  }[];
  /** Their own login to the panel (see PanelAccessBlock). */
  panelAccess?: PanelAccess;
}

function ProfessionalsPageContent() {
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const t = useTranslations();
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingProfessional, setEditingProfessional] =
    useState<Professional | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    profileImage: "",
    bio: "",
    specialties: "",
    position: "",
    commissionRate: "",
    hireDate: "",
    isActive: true,
    serviceIds: [] as string[],
  });

  // The rate as the modal opened it: an update sends it only when changed.
  const [initialCommissionRate, setInitialCommissionRate] = useState("");

  // Why the drawer's save failed, shown inside the drawer: the page's own
  // error banner is behind it (the drawer covers the whole screen).
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Deleting and deactivating are confirmed in the panel's dialog.
  const [confirmDelete, setConfirmDelete] = useState<Professional | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<
    { professional: Professional; upcoming: number | null } | null
  >(null);
  const [busy, setBusy] = useState(false);

  // Password change dialog state
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [passwordData, setPasswordData] = useState({
    newPassword: "",
    confirmPassword: "",
  });

  useEffect(() => {
    fetchProfessionals();
    fetchServices();
  }, []);

  // Check for ?new=true query parameter to open add professional form
  useEffect(() => {
    if (searchParams?.get("new") === "true") {
      setShowForm(true);
    }
  }, [searchParams]);

  const fetchServices = async () => {
    try {
      const data = await apiClient.getServices();
      setServices(data);
    } catch (err) {
      // No invented catalogue: its ids do not exist, so assigning one to a
      // professional failed on save.
      console.error("Failed to fetch services:", err);
      setServices([]);
    }
  };

  const fetchProfessionals = async () => {
    try {
      setLoading(true);
      const response = await apiClient.getProfessionals();

      // The admin endpoint returns { data: Professional[], total, page, limit, totalPages }
      // We need to extract the data array
      const professionalsData = Array.isArray(response)
        ? response
        : (response as any)?.data || [];

      // Ensure services are properly included in the response
      const professionalsWithServices = professionalsData.map(
        (professional: any) => ({
          ...professional,
          services: professional.services || [],
        }),
      ) as Professional[];

      setProfessionals(professionalsWithServices);
      setError(null);
    } catch (err) {
      // No invented team. This used to show mock professionals (Maria
      // Garcia, John Smith) and clear the error, so a failed load looked like
      // a salon with two staff members nobody had hired.
      console.error("fetchProfessionals error:", err);
      setProfessionals([]);
      setError(err instanceof Error ? err.message : "No se ha podido cargar el equipo.");
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const specialtiesArray = formData.specialties
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (editingProfessional) {
        // Build update payload with only non-empty/undefined values
        const updateData: Record<string, any> = {};

        if (formData.firstName) updateData.firstName = formData.firstName;
        if (formData.lastName) updateData.lastName = formData.lastName;
        if (formData.email) updateData.email = formData.email;
        if (formData.phone) updateData.phone = formData.phone;
        if (formData.profileImage)
          updateData.profileImage = formData.profileImage;
        if (formData.bio) updateData.bio = formData.bio;
        if (specialtiesArray.length > 0)
          updateData.specialties = specialtiesArray;
        if (formData.position) updateData.position = formData.position;
        // 0 is a rate, emptied clears it (null), untouched is left out.
        const commissionRate = commissionRateForUpdate(
          formData.commissionRate,
          initialCommissionRate,
        );
        if (commissionRate !== undefined)
          updateData.commissionRate = commissionRate;
        if (formData.hireDate) updateData.hireDate = formData.hireDate;
        updateData.isActive = formData.isActive;
        if (formData.serviceIds.length > 0)
          updateData.serviceIds = formData.serviceIds;

        await (apiClient as any).updateProfessional(
          editingProfessional.id,
          updateData,
        );
      } else {
        await (apiClient as any).createProfessional({
          firstName: formData.firstName,
          lastName: formData.lastName,
          email: formData.email,
          phone: formData.phone || undefined,
          profileImage: formData.profileImage || undefined,
          bio: formData.bio || undefined,
          specialties: specialtiesArray,
          position: formData.position || undefined,
          commissionRate: commissionRateForCreate(formData.commissionRate),
          hireDate: formData.hireDate ? new Date(formData.hireDate) : undefined,
          serviceIds: formData.serviceIds,
        });
      }

      setShowForm(false);
      setEditingProfessional(null);
      setFormData({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        profileImage: "",
        bio: "",
        specialties: "",
        position: "",
        commissionRate: "",
        hireDate: "",
        isActive: true,
        serviceIds: [],
      });
      fetchProfessionals();
    } catch (err) {
      // Inside the drawer, where the user is looking; the server says why
      // (in Spanish), e.g. an email already in use or the plan's limit.
      setFormError(
        err instanceof Error && err.message
          ? err.message
          : "No se ha podido guardar. Revisa los datos e inténtalo de nuevo.",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (professional: Professional) => {
    // Direct access to services
    const services = professional.services || [];

    // Extract service IDs - use serviceId first, then fallback to service.id
    const serviceIds = Array.isArray(services)
      ? services
          .map((ps) => ps.serviceId || ps.service?.id)
          .filter((id): id is string => typeof id === "string")
      : [];

    setFormError(null);
    setEditingProfessional(professional);
    setInitialCommissionRate(commissionRateFieldValue(professional.commissionRate));
    setFormData({
      firstName: professional.firstName,
      lastName: professional.lastName,
      email: professional.email,
      phone: professional.phone || "",
      profileImage: professional.profileImage || "",
      bio: professional.bio || "",
      specialties: professional.specialties.join(", "),
      position: professional.position || "",
      commissionRate: commissionRateFieldValue(professional.commissionRate),
      hireDate: professional.hireDate
        ? professional.hireDate.split("T")[0]
        : "",
      isActive: professional.isActive,
      serviceIds,
    });
    setShowForm(true);
  };

  const performDelete = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      // With appointments they are history: the server deactivates them
      // instead, and the reloaded list shows them inactive.
      const { deactivated } = await apiClient.deleteProfessional(confirmDelete.id);
      toast({
        title: t(
          deactivated
            ? "professionals.professional_deactivated"
            : "professionals.professional_deleted",
        ),
        description: t(
          deactivated
            ? "professionals.professional_deactivated_history"
            : "professionals.professional_deleted_success",
        ),
        variant: "default",
      });
      fetchProfessionals();
    } catch (err) {
      // The server says why (e.g. they have history), in Spanish.
      toast({
        title: t("professionals.failed_to_delete"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  const setActive = async (professional: Professional, isActive: boolean) => {
    setBusy(true);
    try {
      await apiClient.updateProfessional(professional.id, { isActive });
      fetchProfessionals();
    } catch (err) {
      // The real reason, e.g. the plan's limit of active professionals.
      toast({
        title: isActive ? "No se ha podido activar" : "No se ha podido desactivar",
        description:
          err instanceof Error && err.message ? err.message : "Inténtalo de nuevo en unos segundos.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
      setConfirmDeactivate(null);
    }
  };

  const handleToggleActive = async (professional: Professional) => {
    if (!professional.isActive) {
      await setActive(professional, true);
      return;
    }
    // Deactivating is confirmed, with what it leaves behind: their upcoming
    // appointments (they are not cancelled or moved by themselves).
    setConfirmDeactivate({ professional, upcoming: null });
    try {
      const { count } = await apiClient.getProfessionalUpcomingCount(professional.id);
      setConfirmDeactivate((current) =>
        current?.professional.id === professional.id ? { professional, upcoming: count } : current,
      );
    } catch {
      // The dialog still works without the number.
    }
  };

  const closeForm = () => {
    setShowForm(false);
    setFormError(null);
    setEditingProfessional(null);
    setFormData({
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      profileImage: "",
      bio: "",
      specialties: "",
      position: "",
      commissionRate: "",
      hireDate: "",
      isActive: true,
      serviceIds: [],
    });
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProfessional) return;

    if (passwordData.newPassword !== passwordData.confirmPassword) {
      toast({
        title: "Error",
        description: "Las contraseñas nuevas no coinciden",
        variant: "destructive",
      });
      return;
    }

    try {
      await apiClient.changeProfessionalPassword(editingProfessional.id, {
        newPassword: passwordData.newPassword,
      });

      toast({
        title: "Contraseña actualizada",
        description:
          "La contraseña del profesional ha sido cambiada exitosamente",
      });

      setShowPasswordDialog(false);
      setPasswordData({
        newPassword: "",
        confirmPassword: "",
      });
    } catch (err) {
      console.error("Error changing password:", err);
      toast({
        title: "Error",
        description:
          err instanceof Error
            ? err.message
            : "No se pudo cambiar la contraseña",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="p-6">
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold truncate">{t("professionals.title")}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setShowForm(true)}>
            <Plus className="w-4 h-4 mr-2" />
            {t("professionals.add_professional")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8">{t("professionals.loading")}</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {professionals.map((professional) => (
            <Card key={professional.id} className="p-4 flex flex-col">
              <div className="flex items-start gap-4">
                {professional.profileImage ? (
                  <img
                    src={professional.profileImage}
                    alt={`${professional.firstName} ${professional.lastName}`}
                    className="w-16 h-16 object-cover rounded-lg flex-shrink-0"
                    style={{ maxWidth: "100%", height: "auto" }}
                  />
                ) : (
                  <div className="w-16 h-16 bg-indigo-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <span className="text-indigo-600 font-bold text-xl">
                      {professional.firstName.charAt(0)}
                      {professional.lastName.charAt(0)}
                    </span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-start mb-1">
                    <div className="min-w-0">
                      <h3 className="font-semibold text-lg break-words">
                        {professional.firstName} {professional.lastName}
                      </h3>
                      <p className="text-gray-500 text-sm break-words">
                        {professional.email}
                      </p>
                    </div>
                    <span
                      className={`px-2 py-1 text-xs rounded-full flex-shrink-0 ml-2 ${
                        professional.isActive
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {professional.isActive
                        ? t("professionals.active")
                        : t("professionals.inactive")}
                    </span>
                  </div>

                  <div className="mb-3">
                    <p className="text-sm text-gray-600 break-words">
                      <span className="font-medium">
                        {t("professionals.specialties")}:
                      </span>{" "}
                      {professional.specialties.length > 0
                        ? professional.specialties.join(", ")
                        : t("professionals.none_listed")}
                    </p>
                    {professional.position && (
                      <p className="text-sm text-gray-600 break-words">
                        <span className="font-medium">
                          {t("professionals.position")}:
                        </span>{" "}
                        {professional.position}
                      </p>
                    )}
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => handleEdit(professional)}
                      title={t("professionals.edit_tooltip")}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => handleToggleActive(professional)}
                      title={
                        professional.isActive
                          ? t("professionals.deactivate_tooltip")
                          : t("professionals.activate_tooltip")
                      }
                    >
                      <Power className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="destructive"
                      size="icon"
                      onClick={() => setConfirmDelete(professional)}
                      title={t("professionals.delete_tooltip")}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <PanelAccessBlock
                    professionalId={professional.id}
                    name={`${professional.firstName} ${professional.lastName}`}
                    email={professional.email}
                    access={professional.panelAccess}
                  />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Form Drawer */}
      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-end z-50">
          <div className="bg-white w-full max-w-3xl h-full p-6 overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold">
                {editingProfessional
                  ? t("professionals.edit_professional")
                  : t("professionals.add_professional_title")}
              </h2>
              <button
                onClick={closeForm}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {formError && (
                <div role="alert" className="bg-red-50 text-red-700 p-3 rounded-lg text-sm">
                  {formError}
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("professionals.first_name")} *
                  </label>
                  <Input
                    value={formData.firstName}
                    onChange={(e) =>
                      setFormData({ ...formData, firstName: e.target.value })
                    }
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("professionals.last_name")} *
                  </label>
                  <Input
                    value={formData.lastName}
                    onChange={(e) =>
                      setFormData({ ...formData, lastName: e.target.value })
                    }
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("professionals.email")} *
                </label>
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) =>
                    setFormData({ ...formData, email: e.target.value })
                  }
                  required
                />
                {editingProfessional?.panelAccess?.status === "active" && (
                  <button
                    type="button"
                    onClick={() => setShowPasswordDialog(true)}
                    className="text-sm text-indigo-600 hover:text-indigo-800 mt-1 block"
                  > {t("professionals.change_password")}</button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("professionals.phone")}
                  </label>
                  <Input
                    type="tel"
                    value={formData.phone}
                    onChange={(e) =>
                      setFormData({ ...formData, phone: e.target.value })
                    }
                    placeholder={t("professionals.placeholderPhone")}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("professionals.hire_date")}
                  </label>
                  <Input
                    type="date"
                    value={formData.hireDate}
                    onChange={(e) =>
                      setFormData({ ...formData, hireDate: e.target.value })
                    }
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("professionals.profile_image")}
                </label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onloadend = () => {
                        setFormData({
                          ...formData,
                          profileImage: reader.result as string,
                        });
                      };
                      reader.readAsDataURL(file);
                    }
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                />
                {formData.profileImage && (
                  <div className="mt-2">
                    <img
                      src={formData.profileImage}
                      alt="Preview"
                      className="w-20 h-20 object-cover rounded-lg"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setFormData({ ...formData, profileImage: "" })
                      }
                      className="text-red-500 text-sm mt-1"
                    >
                      {t("professionals.remove")}
                    </button>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("professionals.bio")}
                </label>
                <textarea
                  value={formData.bio}
                  onChange={(e) =>
                    setFormData({ ...formData, bio: e.target.value })
                  }
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  placeholder={t("professionals.placeholderBio")}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("professionals.position")}
                  </label>
                  <Input
                    value={formData.position}
                    onChange={(e) =>
                      setFormData({ ...formData, position: e.target.value })
                    }
                    placeholder={t("professionals.placeholderSpecialty")}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    {t("professionals.commission_rate")}
                  </label>
                  <Input
                    type="number"
                    value={formData.commissionRate}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        commissionRate: e.target.value,
                      })
                    }
                    placeholder={t("professionals.commission_rate_empty")}
                    min="0"
                    max="100"
                    step="0.01"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("professionals.specialties_comma_separated")}
                </label>
                <Input
                  value={formData.specialties}
                  onChange={(e) =>
                    setFormData({ ...formData, specialties: e.target.value })
                  }
                  placeholder={t("professionals.placeholderSpecialties")}
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">
                  {t("professionals.services")}
                </label>
                <div className="mt-1 grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {services.map((service) => (
                    <label
                      key={service.id}
                      className="flex items-center space-x-2 p-2 border border-gray-200 rounded-md cursor-pointer hover:bg-gray-50"
                    >
                      <input
                        type="checkbox"
                        checked={formData.serviceIds.includes(service.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setFormData({
                              ...formData,
                              serviceIds: [...formData.serviceIds, service.id],
                            });
                          } else {
                            setFormData({
                              ...formData,
                              serviceIds: formData.serviceIds.filter(
                                (id) => id !== service.id,
                              ),
                            });
                          }
                        }}
                        className="text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="text-sm text-gray-700">
                        {service.name}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="isActive"
                  checked={formData.isActive}
                  onChange={(e) =>
                    setFormData({ ...formData, isActive: e.target.checked })
                  }
                  className="text-indigo-600 focus:ring-indigo-500"
                />
                <label htmlFor="isActive" className="text-sm text-gray-700">
                  {t("professionals.active")}
                </label>
              </div>
              {editingProfessional?.isActive && !formData.isActive && (
                <p className="text-xs text-amber-700 -mt-2">
                  Al desactivarlo deja de aparecer para reservar y, si entra al panel, se le quita el acceso.
                  Sus citas pendientes no se cancelan: reasígnalas. Si vuelve, tendrás que darle acceso otra vez.
                </p>
              )}
              {editingProfessional?.panelAccess?.status === "active" &&
                formData.email.trim().toLowerCase() !== (editingProfessional.email ?? "").trim().toLowerCase() && (
                  <p className="text-xs text-amber-700 -mt-2">
                    Con el email nuevo también cambia el email con el que entra al panel.
                  </p>
                )}

              <div className="flex justify-end space-x-2 pt-6">
                <Button type="button" variant="outline" onClick={closeForm}>
                  {t("professionals.cancel")}
                </Button>
                <Button type="submit" disabled={saving}>
                  {editingProfessional
                    ? t("professionals.update_professional")
                    : t("professionals.create_professional")}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={`¿Eliminar a ${confirmDelete?.firstName ?? ""} ${confirmDelete?.lastName ?? ""}?`}
        description={
          <div className="space-y-2">
            <p>
              Si tiene citas en su historial no se borra: se desactiva para conservar ese historial y deja
              de aparecer para reservar.
            </p>
            <p>
              Si entra al panel, pierde el acceso y se cierran sus sesiones. Si vuelve a trabajar contigo,
              tendrás que darle acceso de nuevo.
            </p>
          </div>
        }
        confirmLabel="Eliminar"
        destructive
        loading={busy}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={performDelete}
      />

      <ConfirmDialog
        open={!!confirmDeactivate}
        title={`¿Desactivar a ${confirmDeactivate?.professional.firstName ?? ""} ${
          confirmDeactivate?.professional.lastName ?? ""
        }?`}
        description={
          <div className="space-y-2">
            <p>Dejará de aparecer para reservar online y en la recepcionista.</p>
            <p>
              {confirmDeactivate?.upcoming == null
                ? "Comprobando sus citas pendientes…"
                : confirmDeactivate.upcoming === 0
                  ? "No tiene citas pendientes."
                  : `Tiene ${confirmDeactivate.upcoming} ${
                      confirmDeactivate.upcoming === 1 ? "cita pendiente" : "citas pendientes"
                    } de hoy en adelante. No se cancelan ni se mueven solas: reasígnalas a otra persona del equipo.`}
            </p>
            <p>
              Si entra al panel, pierde el acceso y se cierran sus sesiones. Al reactivarlo tendrás que
              darle acceso de nuevo.
            </p>
          </div>
        }
        confirmLabel="Desactivar"
        destructive
        loading={busy}
        onCancel={() => setConfirmDeactivate(null)}
        onConfirm={() => confirmDeactivate && setActive(confirmDeactivate.professional, false)}
      />

      {/* Password Change Dialog */}
      {showPasswordDialog && editingProfessional && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
            <div className="flex items-center justify-between p-6 border-b">
              <h3 className="text-lg font-semibold text-gray-900"> {t("professionals.change_password")}</h3>
              <button
                onClick={() => setShowPasswordDialog(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handlePasswordChange} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nueva contraseña
                </label>
                <Input
                  type="password"
                  value={passwordData.newPassword}
                  onChange={(e) =>
                    setPasswordData({
                      ...passwordData,
                      newPassword: e.target.value,
                    })
                  }
                  required
                  placeholder={t("professionals.new_password")}
                  minLength={8}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Confirmar nueva contraseña
                </label>
                <Input
                  type="password"
                  value={passwordData.confirmPassword}
                  onChange={(e) =>
                    setPasswordData({
                      ...passwordData,
                      confirmPassword: e.target.value,
                    })
                  }
                  required
                  placeholder={t("professionals.confirm_new_password")}
                  minLength={8}
                />
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowPasswordDialog(false)}
                >
                  Cancelar
                </Button>
                <Button type="submit">{t("professionals.change_password")}</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// useSearchParams() needs a Suspense boundary for the page to prerender
// (required since Next.js 14.1; 14.0 let it through).
export default function ProfessionalsPage() {
  return (
    <Suspense fallback={null}>
      <ProfessionalsPageContent />
    </Suspense>
  );
}
