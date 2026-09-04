"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import {
  Search,
  Plus,
  Edit,
  Trash2,
  Eye,
  Loader2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/src/components/ui/Button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
  DrawerTrigger,
} from "@/components/ui/drawer";

import apiClient, { Appointment } from "@/lib/api";
import { useToast, toast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";

interface Client {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: "male" | "female" | "other" | "prefer_not_to_say" | "";
  profileImage?: string;
  status: "active" | "inactive" | "blocked";
  notes?: string;
  createdAt: string;
  updatedAt: string;
  // P2A — Spanish tax compliance
  taxId?: string | null;
  taxIdType?: "nif" | "cif" | "nie" | "passport" | "other" | null;
}

type SortField = "firstName" | "lastName" | "email" | "status" | "createdAt";
type SortDirection = "asc" | "desc";

interface ClientFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth?: string;
  gender?: "male" | "female" | "other" | "prefer_not_to_say" | "";
  profileImage?: string;
  status: "active" | "inactive" | "blocked";
  notes?: string;
  taxId?: string;
  taxIdType?: "nif" | "cif" | "nie" | "passport" | "other";
}

export default function ClientsPage() {
  const searchParams = useSearchParams();
  const t = useTranslations();
  const [searchQuery, setSearchQuery] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [selectedClientAppointments, setSelectedClientAppointments] = useState<
    Appointment[]
  >([]);
  const [isAddDrawerOpen, setIsAddDrawerOpen] = useState(false);
  const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false);
  const [isViewDrawerOpen, setIsViewDrawerOpen] = useState(false);
  const [expandedAppointmentId, setExpandedAppointmentId] = useState<
    string | null
  >(null);
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  useEffect(() => {
    if (searchParams?.get("new") === "true") {
      setIsAddDrawerOpen(true);
    }
  }, [searchParams]);

  const [addFormData, setAddFormData] = useState<ClientFormData>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    dateOfBirth: "",
    gender: "",
    profileImage: "",
    status: "active",
    notes: "",
    taxId: "",
    taxIdType: "nif" as "nif" | "cif" | "nie" | "passport" | "other",
  });
  const [editFormData, setEditFormData] = useState<ClientFormData>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    dateOfBirth: "",
    gender: "",
    profileImage: "",
    status: "active",
    notes: "",
    taxId: "",
    taxIdType: "nif" as "nif" | "cif" | "nie" | "passport" | "other",
  });

  useEffect(() => {
    fetchClients();
  }, []);

  const fetchClients = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiClient.getClients();
      setClients(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch clients");
    } finally {
      setLoading(false);
    }
  };

  const handleAddClient = async () => {
    try {
      setError(null);
      let tenantId = "default-tenant";
      const storedUser =
        typeof window !== "undefined" ? localStorage.getItem("user") : null;

      if (storedUser) {
        const user = JSON.parse(storedUser);
        if (user.tenantId) {
          tenantId = user.tenantId;
        }
      }

      const newClient = await apiClient.createClient({
        tenantId,
        firstName: addFormData.firstName,
        lastName: addFormData.lastName,
        email: addFormData.email,
        phone: addFormData.phone,
        dateOfBirth: addFormData.dateOfBirth,
        gender: addFormData.gender,
        profileImage: addFormData.profileImage,
        notes: addFormData.notes,
        taxId: addFormData.taxId || undefined,
        taxIdType: addFormData.taxIdType,
      } as any);

      setClients([...clients, newClient]);
      setAddFormData({
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
        dateOfBirth: "",
        gender: "",
        profileImage: "",
        status: "active",
        notes: "",
      });
      setIsAddDrawerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create client");
    }
  };

  const handleAddFormChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >,
  ) => {
    const { name, value } = e.target;
    setAddFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleEditFormChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >,
  ) => {
    const { name, value } = e.target;
    setEditFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleDelete = async (client: Client) => {
    const toastId = toast({
      title: t("clients.delete_client_title"),
      description: (
        <div className="space-y-2">
          <p>
            {t("clients.delete_client_confirm", {
              name: `${client.firstName} ${client.lastName}`,
            })}
          </p>
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-start">
              <span className="text-red-600 mr-3">
                {t("clients.delete_warning")}:
              </span>
              <div>
                <p className="text-red-800 text-sm">
                  {t("clients.delete_warning_message")}
                </p>
              </div>
            </div>
          </div>
        </div>
      ),
      variant: "destructive",
      open: true,
      action: (
        <div className="flex gap-2">
          <button
            onClick={async () => {
              setDeletingId(client.id);
              try {
                await (apiClient as any).deleteClient(client.id);
                setClients(clients.filter((c) => c.id !== client.id));
                toast({
                  title: t("clients.client_deleted"),
                  description: t("clients.client_deleted_success"),
                  variant: "default",
                });
              } catch (err) {
                setError(
                  err instanceof Error
                    ? err.message
                    : "Failed to delete client",
                );
                toast({
                  title: t("clients.error"),
                  description: t("clients.failed_to_delete"),
                  variant: "destructive",
                });
              } finally {
                setDeletingId(null);
              }
            }}
            className="bg-red-500 text-white px-4 py-2 rounded-md hover:bg-red-600 transition-colors"
          >
            Delete
          </button>
          <button
            onClick={() => {
              toastId.dismiss();
            }}
            className="bg-gray-200 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-300 transition-colors"
          >
            {t("clients.cancel")}
          </button>
        </div>
      ),
    });
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const getSortedClients = () => {
    let filtered = clients.filter((client) => {
      const fullName = `${client.firstName} ${client.lastName}`.toLowerCase();
      const email = client.email?.toLowerCase() || "";
      const query = searchQuery.toLowerCase();
      return fullName.includes(query) || email.includes(query);
    });

    return filtered.sort((a, b) => {
      let aVal = a[sortField];
      let bVal = b[sortField];

      if (
        sortField === "firstName" ||
        sortField === "lastName" ||
        sortField === "email"
      ) {
        aVal = (aVal || "").toString().toLowerCase();
        bVal = (bVal || "").toString().toLowerCase();
      }

      if ((aVal as any) < (bVal as any))
        return sortDirection === "asc" ? -1 : 1;
      if ((aVal as any) > (bVal as any))
        return sortDirection === "asc" ? 1 : -1;
      return 0;
    });
  };

  const openViewDrawer = async (client: Client) => {
    setSelectedClient(client);
    try {
      const appointments = await apiClient.getAppointments({
        clientId: client.id,
      });
      const sortedAppointments = appointments.sort(
        (a: Appointment, b: Appointment) => {
          const dateA = new Date(a.scheduledDate);
          const dateB = new Date(b.scheduledDate);
          if (dateA.getTime() !== dateB.getTime()) {
            return dateB.getTime() - dateA.getTime();
          } else {
            return b.scheduledTime.localeCompare(a.scheduledTime);
          }
        },
      );
      setSelectedClientAppointments(sortedAppointments);
    } catch (err) {
      console.error("Failed to fetch client appointments:", err);
      setSelectedClientAppointments([]);
    }
    setIsViewDrawerOpen(true);
  };

  const openEditDrawer = (client: Client) => {
    setSelectedClient(client);
    setEditFormData({
      firstName: client.firstName,
      lastName: client.lastName,
      email: client.email || "",
      phone: client.phone || "",
      dateOfBirth: client.dateOfBirth ? client.dateOfBirth.split("T")[0] : "",
      gender: client.gender || "",
      profileImage: client.profileImage || "",
      status: client.status,
      notes: client.notes || "",
    });
    setIsEditDrawerOpen(true);
  };

  const handleViewClient = async (client: Client) => {
    setSelectedClient(client);
    try {
      const appointments = await apiClient.getAppointments({
        clientId: client.id,
      });
      setSelectedClientAppointments(appointments);
    } catch (error) {
      console.error("Failed to fetch client appointments:", error);
      setSelectedClientAppointments([]);
    }
    setIsViewDrawerOpen(true);
  };

  const handleEditClientClick = (client: Client) => {
    setSelectedClient(client);
    setEditFormData({
      firstName: client.firstName,
      lastName: client.lastName,
      email: client.email || "",
      phone: client.phone || "",
      dateOfBirth: client.dateOfBirth || "",
      gender: client.gender || "",
      profileImage: client.profileImage || "",
      status: client.status,
      notes: client.notes || "",
      taxId: client.taxId || "",
      taxIdType: (client.taxIdType as any) || ("nif" as const),
    });
    setIsEditDrawerOpen(true);
  };

  const handleEditClient = async () => {
    if (!selectedClient) return;

    try {
      setError(null);

      const cleanedData: Record<string, any> = {};
      if (editFormData.firstName)
        cleanedData.firstName = editFormData.firstName;
      if (editFormData.lastName) cleanedData.lastName = editFormData.lastName;
      if (editFormData.email) cleanedData.email = editFormData.email;
      if (editFormData.phone) cleanedData.phone = editFormData.phone;
      if (editFormData.dateOfBirth)
        cleanedData.dateOfBirth = editFormData.dateOfBirth;
      if (editFormData.gender) cleanedData.gender = editFormData.gender;
      if (editFormData.status)
        cleanedData.status = editFormData.status.toLowerCase();
      if (editFormData.notes) cleanedData.notes = editFormData.notes;
      if (editFormData.taxId) {
        cleanedData.taxId = editFormData.taxId.toUpperCase().replace(/\s/g, "");
        cleanedData.taxIdType = editFormData.taxIdType;
      }

      const updatedClient = await (apiClient as any).updateClient(
        selectedClient.id,
        cleanedData,
      );
      setClients(
        clients.map((client) =>
          client.id === selectedClient.id ? updatedClient : client,
        ),
      );
      setIsEditDrawerOpen(false);
      toast({
        title: t("clients.client_updated"),
        description: t("clients.client_updated_success"),
        variant: "default",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update client");
      toast({
        title: t("clients.error"),
        description: t("clients.failed_to_update"),
        variant: "destructive",
      });
    }
  };

  const openDeleteDrawer = (client: Client) => {
    handleDelete(client);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <ArrowUpDown className="w-4 h-4 text-gray-400" />;
    }
    return sortDirection === "asc" ? (
      <ArrowUp className="w-4 h-4 text-indigo-600" />
    ) : (
      <ArrowDown className="w-4 h-4 text-indigo-600" />
    );
  };

  const sortedClients = getSortedClients();

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">
            {t("clients.title")}
          </h1>
          <p className="text-gray-500 mt-1">{t("clients.description")}</p>
        </div>

        {/* Add Client Drawer */}
        <div className="flex flex-wrap items-center gap-3">
        <Drawer open={isAddDrawerOpen} onOpenChange={setIsAddDrawerOpen}>
          <DrawerTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              {t("clients.add_client")}
            </Button>
          </DrawerTrigger>
          <DrawerContent className="max-w-md sm:max-w-lg lg:max-w-3xl">
            <DrawerHeader>
              <DrawerTitle>{t("clients.add_new_client")}</DrawerTitle>
              <DrawerDescription>
                {t("clients.enter_client_info")}
              </DrawerDescription>
            </DrawerHeader>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("clients.first_name")} *
                  </label>
                  <input
                    type="text"
                    id="firstName"
                    value={addFormData.firstName}
                    onChange={handleAddFormChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder={t("clients.placeholderFirstName")}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("clients.last_name")} *
                  </label>
                  <input
                    type="text"
                    id="lastName"
                    value={addFormData.lastName}
                    onChange={handleAddFormChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder={t("clients.placeholderLastName")}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("clients.email")}
                  </label>
                  <input
                    type="email"
                    id="email"
                    value={addFormData.email}
                    onChange={handleAddFormChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder={t("clients.placeholderEmail")}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("clients.phone")}
                  </label>
                  <input
                    type="tel"
                    id="phone"
                    value={addFormData.phone}
                    onChange={handleAddFormChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder={t("clients.placeholderPhone")}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {"NIF / CIF / NIE"}
                  </label>
                  <div className="flex gap-2">
                    <select
                      id="taxIdType"
                      value={addFormData.taxIdType}
                      onChange={handleAddFormChange}
                      className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="nif">NIF</option>
                      <option value="cif">CIF</option>
                      <option value="nie">NIE</option>
                      <option value="passport">Pasaporte</option>
                      <option value="other">Otro</option>
                    </select>
                    <input
                      type="text"
                      id="taxId"
                      value={addFormData.taxId}
                      onChange={handleAddFormChange}
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg uppercase focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="B12345678"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("clients.date_of_birth")}
                  </label>
                  <input
                    type="date"
                    id="dateOfBirth"
                    value={addFormData.dateOfBirth}
                    onChange={handleAddFormChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("clients.gender")}
                  </label>
                  <select
                    id="gender"
                    value={addFormData.gender}
                    onChange={handleAddFormChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">{t("clients.select_gender")}</option>
                    <option value="male">{t("clients.male")}</option>
                    <option value="female">{t("clients.female")}</option>
                    <option value="other">{t("clients.other")}</option>
                    <option value="prefer_not_to_say">
                      {t("clients.prefer_not_to_say")}
                    </option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("clients.status")}
                  </label>
                  <select
                    id="status"
                    value={addFormData.status}
                    onChange={handleAddFormChange}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="active">{t("clients.active")}</option>
                    <option value="inactive">{t("clients.inactive")}</option>
                    <option value="blocked">{t("clients.blocked")}</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("clients.notes")}
                  </label>
                  <textarea
                    id="notes"
                    value={addFormData.notes}
                    onChange={handleAddFormChange}
                    rows={4}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                    placeholder="Add notes about this client (e.g., hair color preferences, cutting preferences, allergies, etc.)"
                  />
                </div>
              </div>
            </div>

            <DrawerFooter>
              <Button
                onClick={handleAddClient}
                disabled={!addFormData.firstName || !addFormData.lastName}
              >
                {t("clients.add_client")}
              </Button>
              <DrawerClose asChild>
                <Button variant="outline">{t("common.cancel")}</Button>
              </DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="relative w-full sm:flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder={t("clients.search_clients")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <div className="flex items-center space-x-2">
          <ArrowUpDown className="w-4 h-4 text-gray-400" />
          <select
            value={`${sortField}-${sortDirection}`}
            onChange={(e) => {
              const [field, direction] = e.target.value.split("-") as [
                SortField,
                SortDirection,
              ];
              setSortField(field);
              setSortDirection(direction);
            }}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="firstName-asc">{t("clients.client")} A-Z</option>
            <option value="firstName-desc">{t("clients.client")} Z-A</option>
            <option value="createdAt-desc">
              {t("clients.created")} (Newest)
            </option>
            <option value="createdAt-asc">
              {t("clients.created")} (Oldest)
            </option>
            <option value="status-asc">{t("clients.status")} A-Z</option>
            <option value="status-desc">{t("clients.status")} Z-A</option>
          </select>
        </div>
      </div>

      {/* Clients Table */}
      <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-[720px] w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                  onClick={() => handleSort("firstName")}
                >
                  <div className="flex items-center space-x-1">
                    <span>{t("clients.client")}</span>
                    {sortField === "firstName" &&
                      (sortDirection === "asc" ? (
                        <ArrowUp className="w-4 h-4" />
                      ) : (
                        <ArrowDown className="w-4 h-4" />
                      ))}
                  </div>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap"
                >
                  {t("clients.contact")}
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100 whitespace-nowrap"
                  onClick={() => handleSort("status")}
                >
                  <div className="flex items-center space-x-1">
                    <span>{t("clients.status")}</span>
                    {sortField === "status" &&
                      (sortDirection === "asc" ? (
                        <ArrowUp className="w-4 h-4" />
                      ) : (
                        <ArrowDown className="w-4 h-4" />
                      ))}
                  </div>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                  onClick={() => handleSort("createdAt")}
                >
                  <div className="flex items-center space-x-1">
                    <span>{t("clients.created")}</span>
                    {sortField === "createdAt" &&
                      (sortDirection === "asc" ? (
                        <ArrowUp className="w-4 h-4" />
                      ) : (
                        <ArrowDown className="w-4 h-4" />
                      ))}
                  </div>
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  {t("clients.actions")}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <div className="flex items-center justify-center">
                      <Loader2 className="w-6 h-6 animate-spin mr-2" />
                      <span className="text-gray-500">
                        {t("common.loading")}
                      </span>
                    </div>
                  </td>
                </tr>
              ) : sortedClients.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <p className="text-gray-500">
                      {t("clients.no_clients_found")}
                    </p>
                  </td>
                </tr>
              ) : (
                sortedClients.map((client) => (
                  <tr key={client.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="flex-shrink-0 w-10 h-10">
                          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center">
                            <span className="text-white font-semibold text-sm">
                              {client.firstName.charAt(0)}
                              {client.lastName.charAt(0)}
                            </span>
                          </div>
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900">
                            {client.firstName} {client.lastName}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="text-sm text-gray-900">
                        {client.email || "-"}
                      </div>
                      <div className="text-sm text-gray-500">
                        {client.phone || "-"}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span
                        className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                          client.status === "active"
                            ? "bg-green-100 text-green-800"
                            : client.status === "inactive"
                              ? "bg-yellow-100 text-yellow-800"
                              : client.status === "blocked"
                                ? "bg-red-100 text-red-800"
                                : "bg-blue-100 text-blue-800"
                        }`}
                      >
                        {t(`clients.${client.status}`)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(client.createdAt)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end space-x-2">
                        <button
                          onClick={() => handleViewClient(client)}
                          className="text-indigo-600 hover:text-indigo-900 p-1 rounded-md hover:bg-indigo-50 transition-colors"
                          title={t("clients.view_details")}
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleEditClientClick(client)}
                          className="text-blue-600 hover:text-blue-900 p-1 rounded-md hover:bg-blue-50 transition-colors"
                          title={t("clients.edit_client")}
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(client)}
                          className="text-red-600 hover:text-red-900 p-1 rounded-md hover:bg-red-50 transition-colors"
                          title={t("clients.delete_client")}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* View Client Drawer */}
      <Drawer open={isViewDrawerOpen} onOpenChange={setIsViewDrawerOpen}>
        <DrawerContent className="max-w-md lg:max-w-6xl h-screen pb-10">
          {selectedClient && (
            <>
              <DrawerHeader>
                <div className="flex items-center space-x-3 mb-2">
                  <div className="w-12 h-12 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center">
                    <span className="text-white font-semibold text-lg">
                      {selectedClient.firstName.charAt(0)}
                      {selectedClient.lastName.charAt(0)}
                    </span>
                  </div>
                  <div>
                    <DrawerTitle className="text-xl font-bold text-gray-900">
                      {selectedClient.firstName} {selectedClient.lastName}
                    </DrawerTitle>
                    <DrawerDescription className="text-sm text-gray-600">
                      {t("clients.client_details")}
                    </DrawerDescription>
                  </div>
                </div>
              </DrawerHeader>

              <div className="p-6 h-full overflow-hidden">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full">
                  {/* Left Column - Client Information */}
                  <div className="space-y-6 overflow-y-auto">
                    <div className="space-y-4">
                      <h3 className="font-medium text-gray-900">
                        {t("clients.contact_information")}
                      </h3>
                      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                        <div className="grid grid-cols-1 gap-4">
                          {selectedClient.email && (
                            <div className="flex items-center space-x-3">
                              <div className="p-2 bg-gray-100 rounded-lg">
                                <span className="text-sm text-gray-600">
                                  {t("clients.email")}
                                </span>
                              </div>
                              <p className="font-medium text-gray-900">
                                {selectedClient.email}
                              </p>
                            </div>
                          )}
                          {selectedClient.phone && (
                            <div className="flex items-center space-x-3">
                              <div className="p-2 bg-gray-100 rounded-lg">
                                <span className="text-sm text-gray-600">
                                  {t("clients.phone")}
                                </span>
                              </div>
                              <p className="font-medium text-gray-900">
                                {selectedClient.phone}
                              </p>
                            </div>
                          )}
                          {selectedClient.dateOfBirth && (
                            <div className="flex items-center space-x-3">
                              <div className="p-2 bg-gray-100 rounded-lg">
                                <span className="text-sm text-gray-600">
                                  {t("clients.date_of_birth")}
                                </span>
                              </div>
                              <p className="font-medium text-gray-900">
                                {formatDate(selectedClient.dateOfBirth)}
                              </p>
                            </div>
                          )}
                          {selectedClient.gender && (
                            <div className="flex items-center space-x-3">
                              <div className="p-2 bg-gray-100 rounded-lg">
                                <span className="text-sm text-gray-600">
                                  {t("clients.gender")}
                                </span>
                              </div>
                              <p className="font-medium text-gray-900 capitalize">
                                {selectedClient.gender}
                              </p>
                            </div>
                          )}
                          <div className="flex items-center space-x-3">
                            <div className="p-2 bg-gray-100 rounded-lg">
                              <span className="text-sm text-gray-600">
                                {t("clients.created")}
                              </span>
                            </div>
                            <p className="font-medium text-gray-900">
                              {formatDate(selectedClient.createdAt)}
                            </p>
                          </div>
                          <div className="flex items-center space-x-3">
                            <div className="p-2 bg-gray-100 rounded-lg">
                              <span className="text-sm text-gray-600">
                                {t("clients.status")}
                              </span>
                            </div>
                            <span
                              className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                                selectedClient.status === "active"
                                  ? "bg-green-100 text-green-800"
                                  : selectedClient.status === "inactive"
                                    ? "bg-yellow-100 text-yellow-800"
                                    : selectedClient.status === "blocked"
                                      ? "bg-red-100 text-red-800"
                                      : "bg-blue-100 text-blue-800"
                              }`}
                            >
                              {t(`clients.${selectedClient.status}`)}
                            </span>
                          </div>
                          {selectedClient.notes && (
                            <div className="flex items-start space-x-3">
                              <div className="p-2 bg-gray-100 rounded-lg">
                                <span className="text-sm text-gray-600">
                                  {t("clients.notes")}
                                </span>
                              </div>
                              <p className="font-medium text-gray-900 whitespace-pre-wrap">
                                {selectedClient.notes}
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right Column - Appointments */}
                  <div className="space-y-6 overflow-y-auto">
                    <div className="space-y-4">
                      <h3 className="font-medium text-gray-900">
                        {t("clients.appointments")}
                      </h3>
                      {selectedClientAppointments.length === 0 ? (
                        <p className="text-sm text-gray-500">
                          {t("clients.no_appointments_found")}
                        </p>
                      ) : (
                        <div className="space-y-3">
                          {selectedClientAppointments.map((appointment) => {
                            const totalDuration =
                              appointment.services?.reduce(
                                (sum, s) => sum + (s.service?.duration || 0),
                                0,
                              ) || 0;
                            const totalPrice =
                              appointment.services?.reduce(
                                (sum, s) =>
                                  sum +
                                  (parseFloat(String(s.service?.price)) || 0),
                                0,
                              ) || 0;
                            const statusClass =
                              appointment.status === "completed"
                                ? "bg-green-100 text-green-800"
                                : appointment.status === "pending"
                                  ? "bg-yellow-100 text-yellow-800"
                                  : appointment.status === "cancelled"
                                    ? "bg-red-100 text-red-800"
                                    : "bg-blue-100 text-blue-800";

                            return (
                              <div
                                key={appointment.id}
                                className="border rounded-lg overflow-hidden"
                              >
                                <div className="p-3 hover:bg-gray-50 transition-colors">
                                  <div className="flex justify-between items-start">
                                    <div className="flex-1">
                                      <p className="font-medium text-gray-900">
                                        {formatDate(appointment.scheduledDate)}{" "}
                                        {t("common.at")}{" "}
                                        {appointment.scheduledTime}
                                      </p>
                                      <p className="text-sm text-gray-600">
                                        {totalDuration} {t("common.minutes")} •{" "}
                                        {totalPrice.toFixed(2)}€
                                      </p>
                                      {appointment.services &&
                                        appointment.services.length > 0 && (
                                          <p className="text-sm text-gray-600 mt-1">
                                            <strong>
                                              {t("clients.services")}:
                                            </strong>{" "}
                                            {appointment.services
                                              .map(
                                                (s) =>
                                                  `${s.service?.name || t("clients.unknown")} by ${s.professional?.firstName} ${s.professional?.lastName}`,
                                              )
                                              .join(", ")}
                                          </p>
                                        )}
                                      {appointment.notes && (
                                        <p className="text-sm text-gray-600 mt-2">
                                          {appointment.notes}
                                        </p>
                                      )}
                                    </div>
                                    <span
                                      className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                                        appointment.status === "completed"
                                          ? "bg-green-100 text-green-800"
                                          : appointment.status === "pending"
                                            ? "bg-yellow-100 text-yellow-800"
                                            : appointment.status === "cancelled"
                                              ? "bg-red-100 text-red-800"
                                              : "bg-blue-100 text-blue-800"
                                      }`}
                                    >
                                      {t(`clients.${appointment.status}`)}
                                    </span>
                                  </div>

                                  {/* Expand/Collapse Button */}
                                  <div className="flex justify-center mt-3 pt-2 border-t border-gray-100">
                                    <button
                                      onClick={() => {
                                        setExpandedAppointmentId(
                                          expandedAppointmentId ===
                                            appointment.id
                                            ? null
                                            : appointment.id,
                                        );
                                      }}
                                      className="flex items-center text-sm text-gray-500 hover:text-gray-700 transition-colors"
                                    >
                                      {expandedAppointmentId ===
                                      appointment.id ? (
                                        <>
                                          <ChevronUp className="w-4 h-4 mr-1" />
                                          {t("common.show_less")}
                                        </>
                                      ) : (
                                        <>
                                          <ChevronDown className="w-4 h-4 mr-1" />
                                          {t("common.show_more")}
                                        </>
                                      )}
                                    </button>
                                  </div>
                                </div>

                                {/* Expanded Details */}
                                {expandedAppointmentId === appointment.id && (
                                  <div className="px-3 pb-3 bg-gray-50 border-t border-gray-100">
                                    <div className="space-y-4">
                                      <div>
                                        <h4 className="font-semibold text-gray-900 mb-2">
                                          {t("clients.appointment_details")}
                                        </h4>
                                        <div className="space-y-2 text-sm">
                                          <div className="flex justify-between">
                                            <span className="text-gray-600">
                                              {t("clients.date")}:
                                            </span>
                                            <span className="font-medium">
                                              {formatDate(
                                                appointment.scheduledDate,
                                              )}
                                            </span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span className="text-gray-600">
                                              {t("clients.time")}:
                                            </span>
                                            <span className="font-medium">
                                              {appointment.scheduledTime}
                                            </span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span className="text-gray-600">
                                              {t("clients.duration")}:
                                            </span>
                                            <span className="font-medium">
                                              {totalDuration}{" "}
                                              {t("common.minutes")}
                                            </span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span className="text-gray-600">
                                              {t("clients.status")}:
                                            </span>
                                            <span
                                              className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${
                                                appointment.status ===
                                                "completed"
                                                  ? "bg-green-100 text-green-800"
                                                  : appointment.status ===
                                                      "pending"
                                                    ? "bg-yellow-100 text-yellow-800"
                                                    : appointment.status ===
                                                        "cancelled"
                                                      ? "bg-red-100 text-red-800"
                                                      : "bg-blue-100 text-blue-800"
                                              }`}
                                            >
                                              {t(
                                                `clients.${appointment.status}`,
                                              )}
                                            </span>
                                          </div>
                                          <div className="flex justify-between">
                                            <span className="text-gray-600">
                                              {t("clients.price")}:
                                            </span>
                                            <span className="font-medium">
                                              {totalPrice.toFixed(2)}€
                                            </span>
                                          </div>
                                        </div>
                                      </div>

                                      {appointment.services &&
                                        appointment.services.length > 0 && (
                                          <div>
                                            <h5 className="font-medium text-gray-900 mb-2">
                                              {t("clients.services")}
                                            </h5>
                                            <div className="space-y-2">
                                              {appointment.services.map(
                                                (serviceItem, index) => (
                                                  <div
                                                    key={index}
                                                    className="flex justify-between items-center p-2 bg-white rounded"
                                                  >
                                                    <div>
                                                      <p className="font-medium text-sm">
                                                        {serviceItem.service
                                                          ?.name ||
                                                          t("clients.unknown")}
                                                      </p>
                                                      <p className="text-xs text-gray-600">
                                                        {
                                                          serviceItem
                                                            .professional
                                                            ?.firstName
                                                        }{" "}
                                                        {
                                                          serviceItem
                                                            .professional
                                                            ?.lastName
                                                        }
                                                      </p>
                                                    </div>
                                                    <div className="text-right">
                                                      <p className="text-sm font-medium">
                                                        {serviceItem.service
                                                          ?.duration || 0}{" "}
                                                        {t("common.min")}
                                                      </p>
                                                      <p className="text-xs text-gray-600">
                                                        {(
                                                          parseFloat(
                                                            String(
                                                              serviceItem
                                                                .service?.price,
                                                            ),
                                                          ) || 0
                                                        ).toFixed(2)}
                                                        €
                                                      </p>
                                                    </div>
                                                  </div>
                                                ),
                                              )}
                                            </div>
                                          </div>
                                        )}

                                      {appointment.notes && (
                                        <div>
                                          <h5 className="font-medium text-gray-900 mb-2">
                                            {t("clients.notes")}
                                          </h5>
                                          <p className="text-sm text-gray-600 bg-white p-2 rounded">
                                            {appointment.notes}
                                          </p>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <DrawerFooter>
                <Button variant="outline">{t("clients.close")}</Button>
              </DrawerFooter>
            </>
          )}
        </DrawerContent>
      </Drawer>

      {/* Edit Client Drawer */}
      <Drawer open={isEditDrawerOpen} onOpenChange={setIsEditDrawerOpen}>
        <DrawerContent className="max-w-md lg:max-w-4xl">
          {selectedClient && (
            <>
              <DrawerHeader>
                <div className="flex items-center space-x-3 mb-2">
                  <div className="w-12 h-12 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center">
                    <span className="text-white font-semibold text-lg">
                      {selectedClient.firstName.charAt(0)}
                      {selectedClient.lastName.charAt(0)}
                    </span>
                  </div>
                  <div>
                    <DrawerTitle className="text-xl font-bold text-gray-900">
                      {t("clients.edit_client")}
                    </DrawerTitle>
                    <DrawerDescription className="text-sm text-gray-600">
                      {t("clients.update_client_info", {
                        name: `${selectedClient.firstName} ${selectedClient.lastName}`,
                      })}
                    </DrawerDescription>
                  </div>
                </div>
              </DrawerHeader>

              <div className="p-6">
                <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t("clients.first_name")}
                      </label>
                      <input
                        type="text"
                        id="firstName"
                        value={editFormData.firstName}
                        onChange={handleEditFormChange}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder={t("clients.placeholderFirstName")}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t("clients.last_name")}
                      </label>
                      <input
                        type="text"
                        id="lastName"
                        value={editFormData.lastName}
                        onChange={handleEditFormChange}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder={t("clients.placeholderLastName")}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t("clients.email")}
                      </label>
                      <input
                        type="email"
                        id="email"
                        value={editFormData.email}
                        onChange={handleEditFormChange}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder={t("clients.placeholderEmail")}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t("clients.phone")}
                      </label>
                      <input
                        type="tel"
                        id="phone"
                        value={editFormData.phone}
                        onChange={handleEditFormChange}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder={t("clients.placeholderPhone")}
                      />
                    </div>
                    <div className="md:col-span-2 grid grid-cols-3 gap-3">
                      <div>
                        <label htmlFor="taxId" className="block text-sm font-medium text-gray-700 mb-1">
                          {"NIF / CIF / NIE"}
                        </label>
                        <input
                          type="text"
                          id="taxId"
                          value={editFormData.taxId ?? ""}
                          onChange={(e) =>
                            setEditFormData((prev) => ({
                              ...prev,
                              taxId: e.target.value.toUpperCase(),
                            }))
                          }
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg uppercase focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          placeholder="B12345678"
                        />
                      </div>
                      <div>
                        <label htmlFor="taxIdType" className="block text-sm font-medium text-gray-700 mb-1">
                          {"Tipo"}
                        </label>
                        <select
                          id="taxIdType"
                          name="taxIdType"
                          value={editFormData.taxIdType ?? "nif"}
                          onChange={(e) =>
                            setEditFormData((prev) => ({
                              ...prev,
                              taxIdType: e.target.value as any,
                            }))
                          }
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                          <option value="nif">NIF</option>
                          <option value="cif">CIF</option>
                          <option value="nie">NIE</option>
                          <option value="passport">Pasaporte</option>
                          <option value="other">Otro</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t("clients.date_of_birth")}
                      </label>
                      <input
                        type="date"
                        id="dateOfBirth"
                        value={editFormData.dateOfBirth}
                        onChange={handleEditFormChange}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t("clients.gender")}
                      </label>
                      <select
                        id="gender"
                        value={editFormData.gender}
                        onChange={handleEditFormChange}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        <option value="">{t("clients.select_gender")}</option>
                        <option value="male">{t("clients.male")}</option>
                        <option value="female">{t("clients.female")}</option>
                        <option value="other">{t("clients.other")}</option>
                        <option value="prefer_not_to_say">
                          {t("clients.prefer_not_to_say")}
                        </option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t("clients.status")}
                      </label>
                      <select
                        id="status"
                        value={editFormData.status}
                        onChange={handleEditFormChange}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      >
                        <option value="active">{t("clients.active")}</option>
                        <option value="inactive">
                          {t("clients.inactive")}
                        </option>
                        <option value="blocked">{t("clients.blocked")}</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        {t("clients.notes")}
                      </label>
                      <textarea
                        id="notes"
                        value={editFormData.notes}
                        onChange={handleEditFormChange}
                        rows={4}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                        placeholder="Add notes about this client (e.g., hair color preferences, cutting preferences, allergies, etc.)"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <DrawerFooter>
                <Button
                  onClick={handleEditClient}
                  disabled={!editFormData.firstName || !editFormData.lastName}
                >
                  {t("clients.save_changes")}
                </Button>
                <DrawerClose asChild>
                  <Button variant="outline">{t("clients.cancel")}</Button>
                </DrawerClose>
              </DrawerFooter>
            </>
          )}
        </DrawerContent>
      </Drawer>
    </div>
  );
}
