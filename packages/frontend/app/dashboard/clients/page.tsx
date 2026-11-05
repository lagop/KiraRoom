"use client";
import { ImportLink } from "@/components/import-link";

import { useState, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
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
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/src/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
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

import apiClient, { Client } from "@/lib/api";
import { toast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";
import { getCurrentUser } from "@/lib/utils";
import { isManager } from "@/lib/dashboard-nav";
import {
  EMPTY_CLIENT_FORM,
  clientStatusBadgeClass,
  clientToForm,
  createClientPayload,
  formatClientDate,
  updateClientPayload,
  type ClientFormValues,
} from "@/lib/client-form";
import { MarketingRefusalCheckbox, recordNewClientRefusal } from "@/components/marketing/marketing-refusal-checkbox";

type SortField = "firstName" | "lastName" | "email" | "status" | "createdAt";
type SortDirection = "asc" | "desc";
type StatusFilter = "" | Client["status"];

type FieldChange = React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;

/** Rows a page of the list shows. */
const PAGE_SIZE = 25;
/** How long typing pauses before the list is searched again. */
const SEARCH_DELAY_MS = 300;

// The drawers scroll on their own: on a phone the form is taller than the
// screen, and the Save button was out of reach.
const DRAWER_CONTENT = "flex flex-col overflow-y-auto overflow-x-hidden overscroll-contain";
// Below the form, its buttons spaced by the gap (not the default margins).
const DRAWER_FOOTER = "mt-auto gap-2 border-t border-gray-200 pt-4 sm:space-x-0";

function ClientsPageContent() {
  const searchParams = useSearchParams();
  const t = useTranslations();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  // Bumped to fetch the current page again (after adding or deleting).
  const [reloadKey, setReloadKey] = useState(0);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [isAddDrawerOpen, setIsAddDrawerOpen] = useState(false);
  const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clientToDelete, setClientToDelete] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  // Read after mount (the server has no token). Until then nobody counts as
  // a manager: owner-only controls appear once the role is known, rather
  // than flash for staff.
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, []);
  const manager = isManager(role);

  useEffect(() => {
    if (searchParams?.get("new") === "true") {
      setIsAddDrawerOpen(true);
    }
  }, [searchParams]);

  const [addFormData, setAddFormData] = useState<ClientFormValues>(EMPTY_CLIENT_FORM);
  // "No quiere recibir promociones ... por email", unticked.
  const [addRefusesMarketing, setAddRefusesMarketing] = useState(false);
  const [editFormData, setEditFormData] = useState<ClientFormValues>(EMPTY_CLIENT_FORM);

  // The search runs once typing pauses, from the first page.
  useEffect(() => {
    const next = searchQuery.trim();
    if (next === debouncedSearch) return;
    const timer = setTimeout(() => {
      setDebouncedSearch(next);
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchQuery, debouncedSearch]);

  // The server searches, filters, sorts and pages: the list no longer
  // loads every client of the salon at once. Only the latest request's
  // answer is shown, so a slow earlier search cannot overwrite it.
  const requestId = useRef(0);
  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    apiClient
      .getClientsPage({
        page,
        pageSize: PAGE_SIZE,
        q: debouncedSearch || undefined,
        status: statusFilter || undefined,
        sort: sortField,
        dir: sortDirection,
      })
      .then((res) => {
        if (id !== requestId.current) return;
        // A delete can empty the last page: step back to the one before.
        if (res.data.length === 0 && res.page > 1 && res.total > 0) {
          setPage(Math.max(1, res.totalPages));
          return;
        }
        setClients(res.data);
        setTotal(res.total);
        setTotalPages(res.totalPages);
      })
      .catch((err) => {
        if (id !== requestId.current) return;
        setError(err instanceof Error ? err.message : t("clients.failed_to_load"));
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
    // `t` changes identity on every render; the list does not depend on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, debouncedSearch, statusFilter, sortField, sortDirection, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  const handleAddClient = async () => {
    try {
      setError(null);
      setSaving(true);
      const newClient = await apiClient.createClient(
        createClientPayload(addFormData, { canManage: manager }),
      );
      reload();
      if (addRefusesMarketing && !(await recordNewClientRefusal(newClient?.id))) {
        toast({
          title: "Clienta creada, pero no se pudo anotar que no quiere promociones",
          description: "Anótalo desde su ficha, en Promociones.",
          variant: "destructive",
        });
      }
      setAddFormData(EMPTY_CLIENT_FORM);
      setAddRefusesMarketing(false);
      setIsAddDrawerOpen(false);
      toast({ title: t("clients.client_created"), variant: "default" });
    } catch (err) {
      // The server says why (a NIF that does not check out, an email
      // already used in the salon), in Spanish.
      toast({
        title: t("clients.failed_to_create"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  // The inputs are named after the form's fields (see ClientFormFields).
  const handleAddFormChange = (e: FieldChange) => {
    const { name, value } = e.target;
    setAddFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleEditFormChange = (e: FieldChange) => {
    const { name, value } = e.target;
    setEditFormData((prev) => ({ ...prev, [name]: value }));
  };

  // Confirmed in the dialog; its buttons are off while the request runs,
  // so a second click cannot send it twice.
  const confirmDelete = async () => {
    const client = clientToDelete;
    if (!client || deleting) return;
    setDeleting(true);
    try {
      const { deactivated } = await apiClient.deleteClient(client.id);
      // With appointments or payments she is history: the server
      // deactivates her instead, so she stays in the list.
      if (deactivated) {
        setClients((prev) => prev.map((c) => (c.id === client.id ? { ...c, status: "inactive" } : c)));
      } else {
        reload();
      }
      setClientToDelete(null);
      toast({
        title: t(deactivated ? "clients.client_deactivated" : "clients.client_deleted"),
        description: t(
          deactivated ? "clients.client_deactivated_history" : "clients.client_deleted_success",
        ),
        variant: "default",
      });
    } catch (err) {
      // The server says why, in Spanish.
      toast({
        title: t("clients.failed_to_delete"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
    setPage(1);
  };

  const handleEditClientClick = (client: Client) => {
    setSelectedClient(client);
    setEditFormData(clientToForm(client));
    setIsEditDrawerOpen(true);
  };

  const handleEditClient = async () => {
    if (!selectedClient) return;

    try {
      setError(null);
      setSaving(true);
      // Staff edit through /clients/:id, which takes their own clients'
      // details but not the email or the status (the payload leaves them out).
      const updatedClient = await apiClient.updateClient(
        selectedClient.id,
        updateClientPayload(editFormData, { canManage: manager }),
        { asStaff: !manager },
      );
      setClients((prev) =>
        prev.map((client) =>
          client.id === selectedClient.id ? { ...client, ...updatedClient } : client,
        ),
      );
      setIsEditDrawerOpen(false);
      toast({
        title: t("clients.client_updated"),
        description: t("clients.client_updated_success"),
        variant: "default",
      });
    } catch (err) {
      toast({
        title: t("clients.failed_to_update"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const firstRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(page * PAGE_SIZE, total);

  /** A column header that sorts the list, reachable with the keyboard. */
  const sortableHeader = (field: SortField, label: string, className = "") => {
    const active = sortField === field;
    return (
      <th
        scope="col"
        aria-sort={active ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
        className={`px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider ${className}`}
      >
        <button
          type="button"
          onClick={() => handleSort(field)}
          title={t("clients.sort_by_column", { column: label })}
          className="-mx-1 flex items-center space-x-1 rounded px-1 uppercase tracking-wider hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <span>{label}</span>
          {active &&
            (sortDirection === "asc" ? (
              <ArrowUp className="w-4 h-4" aria-hidden="true" />
            ) : (
              <ArrowDown className="w-4 h-4" aria-hidden="true" />
            ))}
        </button>
      </th>
    );
  };

  return (
    <div className="space-y-6">
      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 truncate">
            {t("clients.title")}
          </h1>
          <p className="text-gray-500 mt-1">{t("clients.description")}</p>
        </div>

        {/* Add Client Drawer */}
        <div className="flex flex-wrap items-center gap-3">
        <ImportLink kind="clients" />
        <Drawer open={isAddDrawerOpen} onOpenChange={setIsAddDrawerOpen}>
          <DrawerTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
              {t("clients.add_client")}
            </Button>
          </DrawerTrigger>
          <DrawerContent className={`${DRAWER_CONTENT} max-w-md sm:max-w-lg lg:max-w-3xl`}>
            <DrawerHeader className="pr-8 text-left">
              <DrawerTitle>{t("clients.add_new_client")}</DrawerTitle>
              <DrawerDescription>
                {t("clients.enter_client_info")}
              </DrawerDescription>
            </DrawerHeader>

            <div className="space-y-4 py-4 sm:p-6">
              <ClientFormFields
                idPrefix="add-client"
                values={addFormData}
                onChange={handleAddFormChange}
                requiredMark
                showStatus={manager}
                lockEmail={false}
              />
              <MarketingRefusalCheckbox
                id="add-client-refuses-marketing"
                checked={addRefusesMarketing}
                onChange={setAddRefusesMarketing}
              />
            </div>

            <DrawerFooter className={DRAWER_FOOTER}>
              <Button
                onClick={handleAddClient}
                disabled={saving || !addFormData.firstName.trim() || !addFormData.lastName.trim()}
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
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" aria-hidden="true" />
          <input
            type="search"
            placeholder={t("clients.search_placeholder")}
            aria-label={t("clients.search_label")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={statusFilter}
            aria-label={t("clients.filter_status")}
            onChange={(e) => {
              setStatusFilter(e.target.value as StatusFilter);
              setPage(1);
            }}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="">
              {t("clients.filter_status")}: {t("clients.all_statuses")}
            </option>
            <option value="active">{t("clients.status_active")}</option>
            <option value="inactive">{t("clients.status_inactive")}</option>
            <option value="blocked">{t("clients.status_blocked")}</option>
          </select>
          <ArrowUpDown className="w-4 h-4 text-gray-400" aria-hidden="true" />
          <select
            value={`${sortField}-${sortDirection}`}
            aria-label={t("clients.sort_by")}
            onChange={(e) => {
              const [field, direction] = e.target.value.split("-") as [
                SortField,
                SortDirection,
              ];
              setSortField(field);
              setSortDirection(direction);
              setPage(1);
            }}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="firstName-asc">{t("clients.client")} A-Z</option>
            <option value="firstName-desc">{t("clients.client")} Z-A</option>
            <option value="createdAt-desc">{t("clients.sort_created_newest")}</option>
            <option value="createdAt-asc">{t("clients.sort_created_oldest")}</option>
            <option value="status-asc">{t("clients.status")} A-Z</option>
            <option value="status-desc">{t("clients.status")} Z-A</option>
          </select>
        </div>
      </div>

      {/* Clients Table */}
      <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-[720px] w-full divide-y divide-gray-200" aria-busy={loading}>
            <thead className="bg-gray-50">
              <tr>
                {sortableHeader("firstName", t("clients.client"))}
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap"
                >
                  {t("clients.contact")}
                </th>
                {sortableHeader("status", t("clients.status"), "whitespace-nowrap")}
                {sortableHeader("createdAt", t("clients.created"))}
                <th
                  scope="col"
                  className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider"
                >
                  {t("clients.actions")}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {loading && clients.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <div className="flex items-center justify-center">
                      <Loader2 className="w-6 h-6 animate-spin mr-2" aria-hidden="true" />
                      <span className="text-gray-500">
                        {t("common.loading")}
                      </span>
                    </div>
                  </td>
                </tr>
              ) : clients.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center">
                    <p className="text-gray-500">
                      {t("clients.no_clients_found")}
                    </p>
                  </td>
                </tr>
              ) : (
                clients.map((client) => {
                  const name = `${client.firstName} ${client.lastName}`;
                  return (
                  <tr key={client.id} className={`hover:bg-gray-50 ${loading ? "opacity-60" : ""}`}>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <Link
                        href={`/dashboard/clients/${client.id}`}
                        className="flex items-center group"
                      >
                        <div className="flex-shrink-0 w-10 h-10" aria-hidden="true">
                          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center">
                            <span className="text-white font-semibold text-sm">
                              {client.firstName.charAt(0)}
                              {client.lastName.charAt(0)}
                            </span>
                          </div>
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-gray-900 group-hover:text-indigo-700 group-hover:underline">
                            {name}
                          </div>
                        </div>
                      </Link>
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
                        className={`inline-flex px-2 py-1 rounded-full text-xs font-medium ${clientStatusBadgeClass(client.status)}`}
                      >
                        {t(`clients.status_${client.status}`)}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatClientDate(client.createdAt)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center justify-end space-x-2">
                        <Link
                          href={`/dashboard/clients/${client.id}`}
                          className="text-indigo-600 hover:text-indigo-900 p-1 rounded-md hover:bg-indigo-50 transition-colors"
                          title={t("clients.view_details")}
                          aria-label={`${t("clients.view_details")}: ${name}`}
                        >
                          <Eye className="w-4 h-4" aria-hidden="true" />
                        </Link>
                        <button
                          type="button"
                          onClick={() => handleEditClientClick(client)}
                          className="text-blue-600 hover:text-blue-900 p-1 rounded-md hover:bg-blue-50 transition-colors"
                          title={t("clients.edit_client")}
                          aria-label={`${t("clients.edit_client")}: ${name}`}
                        >
                          <Edit className="w-4 h-4" aria-hidden="true" />
                        </button>
                        {/* Deleting is the owner's or an admin's (the API refuses staff). */}
                        {manager && (
                          <button
                            type="button"
                            onClick={() => setClientToDelete(client)}
                            disabled={deleting}
                            className="text-red-600 hover:text-red-900 p-1 rounded-md hover:bg-red-50 transition-colors disabled:opacity-50"
                            title={t("clients.delete_client")}
                            aria-label={`${t("clients.delete_client")}: ${name}`}
                          >
                            <Trash2 className="w-4 h-4" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {total > 0 && (
          <nav
            aria-label={t("clients.pagination")}
            className="flex items-center justify-between gap-3 border-t border-gray-200 px-4 py-3 text-sm text-gray-600"
          >
            <p aria-live="polite">
              {t("clients.page_summary", { from: firstRow, to: lastRow, total })}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={loading || page <= 1}
                aria-label={t("clients.previous_page")}
                title={t("clients.previous_page")}
              >
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={loading || page >= totalPages}
                aria-label={t("clients.next_page")}
                title={t("clients.next_page")}
              >
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              </Button>
            </div>
          </nav>
        )}
      </div>

      {/* Edit Client Drawer */}
      <Drawer open={isEditDrawerOpen} onOpenChange={setIsEditDrawerOpen}>
        <DrawerContent className={`${DRAWER_CONTENT} max-w-md lg:max-w-4xl`}>
          {selectedClient && (
            <>
              <DrawerHeader className="pr-8 text-left">
                <div className="flex min-w-0 items-center space-x-3 mb-2">
                  <div
                    className="w-12 h-12 flex-shrink-0 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-full flex items-center justify-center"
                    aria-hidden="true"
                  >
                    <span className="text-white font-semibold text-lg">
                      {selectedClient.firstName.charAt(0)}
                      {selectedClient.lastName.charAt(0)}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <DrawerTitle className="text-xl font-bold text-gray-900">
                      {t("clients.edit_client")}
                    </DrawerTitle>
                    <DrawerDescription className="break-words text-sm text-gray-600">
                      {t("clients.update_client_info", {
                        name: `${selectedClient.firstName} ${selectedClient.lastName}`,
                      })}
                    </DrawerDescription>
                  </div>
                </div>
              </DrawerHeader>

              <div className="py-4 sm:p-6">
                <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 sm:p-6 space-y-4">
                  <ClientFormFields
                    idPrefix="edit-client"
                    values={editFormData}
                    onChange={handleEditFormChange}
                    showStatus
                    lockEmail={!manager}
                    lockStatus={!manager}
                  />
                </div>
              </div>

              <DrawerFooter className={DRAWER_FOOTER}>
                <Button
                  onClick={handleEditClient}
                  disabled={saving || !editFormData.firstName.trim() || !editFormData.lastName.trim()}
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

      {/* Deleting removes her file only when she has no history; otherwise
          the server deactivates her. The dialog says both. */}
      <ConfirmDialog
        open={clientToDelete !== null}
        title={
          clientToDelete
            ? t("clients.delete_client_confirm", {
                name: `${clientToDelete.firstName} ${clientToDelete.lastName}`,
              })
            : ""
        }
        description={t("clients.delete_warning_message")}
        confirmLabel={deleting ? t("clients.deleting") : t("clients.delete")}
        cancelLabel={t("clients.cancel")}
        destructive
        loading={deleting}
        onCancel={() => {
          if (!deleting) setClientToDelete(null);
        }}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

const FIELD =
  "w-full min-w-0 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-100 disabled:text-gray-500";
const LABEL = "block text-sm font-medium text-gray-700 mb-1";

/**
 * The add and edit drawers' fields. Each input's `name` is the form field
 * it writes: the drawers' change handler reads it (the inputs once had
 * only an id, and nothing typed reached the form).
 */
function ClientFormFields({
  idPrefix,
  values,
  onChange,
  requiredMark = false,
  showStatus,
  lockEmail,
  lockStatus = false,
}: {
  idPrefix: string;
  values: ClientFormValues;
  onChange: (e: FieldChange) => void;
  requiredMark?: boolean;
  showStatus: boolean;
  lockEmail: boolean;
  lockStatus?: boolean;
}) {
  const t = useTranslations();
  const id = (field: keyof ClientFormValues) => `${idPrefix}-${field}`;
  const required = requiredMark ? " *" : "";
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label htmlFor={id("firstName")} className={LABEL}>
          {t("clients.first_name")}
          {required}
        </label>
        <input
          type="text"
          id={id("firstName")}
          name="firstName"
          value={values.firstName}
          onChange={onChange}
          className={FIELD}
          placeholder={t("clients.placeholderFirstName")}
        />
      </div>
      <div>
        <label htmlFor={id("lastName")} className={LABEL}>
          {t("clients.last_name")}
          {required}
        </label>
        <input
          type="text"
          id={id("lastName")}
          name="lastName"
          value={values.lastName}
          onChange={onChange}
          className={FIELD}
          placeholder={t("clients.placeholderLastName")}
        />
      </div>
      <div>
        <label htmlFor={id("email")} className={LABEL}>
          {t("clients.email")}
        </label>
        <input
          type="email"
          id={id("email")}
          name="email"
          value={values.email}
          onChange={onChange}
          disabled={lockEmail}
          title={lockEmail ? t("clients.managers_only") : undefined}
          className={FIELD}
          placeholder={t("clients.placeholderEmail")}
        />
      </div>
      <div>
        <label htmlFor={id("phone")} className={LABEL}>
          {t("clients.phone")}
        </label>
        <input
          type="tel"
          id={id("phone")}
          name="phone"
          value={values.phone}
          onChange={onChange}
          className={FIELD}
          placeholder={t("clients.placeholderPhone")}
        />
      </div>
      <div>
        <label htmlFor={id("taxId")} className={LABEL}>
          {t("clients.tax_id")}
        </label>
        <div className="flex gap-2">
          <select
            id={id("taxIdType")}
            name="taxIdType"
            aria-label={t("clients.tax_id_type")}
            value={values.taxIdType}
            onChange={onChange}
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
            id={id("taxId")}
            name="taxId"
            value={values.taxId}
            onChange={onChange}
            className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg uppercase focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder="12345678Z"
          />
        </div>
      </div>
      <div>
        <label htmlFor={id("dateOfBirth")} className={LABEL}>
          {t("clients.date_of_birth")}
        </label>
        <input
          type="date"
          id={id("dateOfBirth")}
          name="dateOfBirth"
          value={values.dateOfBirth}
          onChange={onChange}
          className={FIELD}
        />
      </div>
      <div>
        <label htmlFor={id("gender")} className={LABEL}>
          {t("clients.gender")}
        </label>
        <select
          id={id("gender")}
          name="gender"
          value={values.gender}
          onChange={onChange}
          className={FIELD}
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
      {showStatus && (
        <div>
          <label htmlFor={id("status")} className={LABEL}>
            {t("clients.status")}
          </label>
          <select
            id={id("status")}
            name="status"
            value={values.status}
            onChange={onChange}
            disabled={lockStatus}
            title={lockStatus ? t("clients.managers_only") : undefined}
            className={FIELD}
          >
            <option value="active">{t("clients.status_active")}</option>
            <option value="inactive">{t("clients.status_inactive")}</option>
            <option value="blocked">{t("clients.status_blocked")}</option>
          </select>
        </div>
      )}
      <div className="sm:col-span-2">
        <label htmlFor={id("notes")} className={LABEL}>
          {t("clients.notes")}
        </label>
        <textarea
          id={id("notes")}
          name="notes"
          value={values.notes}
          onChange={onChange}
          rows={4}
          className={`${FIELD} resize-none`}
          placeholder={t("clients.notes_placeholder")}
        />
      </div>
    </div>
  );
}

// useSearchParams() needs a Suspense boundary for the page to prerender
// (required since Next.js 14.1; 14.0 let it through).
export default function ClientsPage() {
  return (
    <Suspense fallback={null}>
      <ClientsPageContent />
    </Suspense>
  );
}
