"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { Users, Search, AlertTriangle, Mail, ChevronDown } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  createdAt: string;
  tenant: {
    id: string;
    name: string;
    slug: string;
  };
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
}

export default function SaasUsersPage() {
  const t = useTranslations();
  const [users, setUsers] = useState<User[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedTenant, setSelectedTenant] = useState<string>("");
  const [tenantSearch, setTenantSearch] = useState("");
  const [showTenantDropdown, setShowTenantDropdown] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  const fetchTenants = async () => {
    try {
      const result = await apiClient.getSaasTenants({ page: 1, limit: 100 });
      setTenants(result.data);
    } catch (err) {
      console.error("Error fetching tenants:", err);
    }
  };

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const result = await apiClient.getSaasUsers({
        page,
        limit: 10,
        search: search || undefined,
        tenantId: selectedTenant || undefined,
      });
      setUsers(result.data);
      setTotalPages(result.meta.totalPages);
      setTotal(result.meta.total);
    } catch (err) {
      console.error("Error fetching users:", err);
      setError(t("saas.failedToLoadUsers"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [page, search, selectedTenant]);

  const filteredTenants = useMemo(() => {
    if (!tenantSearch) return tenants;
    const searchLower = tenantSearch.toLowerCase();
    return tenants.filter(t =>
      t.name.toLowerCase().includes(searchLower) ||
      t.slug.toLowerCase().includes(searchLower)
    );
  }, [tenants, tenantSearch]);

  const selectedTenantName = useMemo(() => {
    if (!selectedTenant) return "All Salons";
    const tenant = tenants.find(t => t.id === selectedTenant);
    return tenant?.name || "All Salons";
  }, [selectedTenant, tenants]);

  const getRoleBadge = (role: string) => {
    const colors: Record<string, string> = {
      saas_owner: "bg-purple-100 text-purple-800",
      owner: "bg-blue-100 text-blue-800",
      admin: "bg-indigo-100 text-indigo-800",
      staff: "bg-yellow-100 text-yellow-800",
      client: "bg-gray-100 text-gray-800",
    };
    return (
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[role] || "bg-gray-100 text-gray-800"}`}>
        {role}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">Users</h1>
          <p className="text-gray-500 mt-1">{total} total users across all salons</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            placeholder={t("saas.searchUsers")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-10 pr-4 py-2 border border-gray-200 rounded-lg w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Salon Filter */}
        <div className="relative">
          <button
            onClick={() => setShowTenantDropdown(!showTenantDropdown)}
            className="flex items-center px-4 py-2 border border-gray-200 rounded-lg bg-white hover:bg-gray-50 min-w-[200px] justify-between"
          >
            <span className="text-gray-700">{selectedTenantName}</span>
            <ChevronDown className="w-4 h-4 text-gray-400 ml-2" />
          </button>

          {showTenantDropdown && (
            <div className="absolute z-10 mt-1 w-[280px] bg-white border border-gray-200 rounded-lg shadow-lg">
              <div className="p-2 border-b border-gray-100">
                <input
                  type="text"
                  placeholder={t("saas.searchSalons")}
                  value={tenantSearch}
                  onChange={(e) => setTenantSearch(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>
              <div className="max-h-60 overflow-y-auto">
                <button
                  onClick={() => {
                    setSelectedTenant("");
                    setTenantSearch("");
                    setShowTenantDropdown(false);
                    setPage(1);
                  }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 text-gray-700"
                >
                  {t("saas.allSalons")}
                </button>
                {filteredTenants.map((tenant) => (
                  <button
                    key={tenant.id}
                    onClick={() => {
                      setSelectedTenant(tenant.id);
                      setTenantSearch("");
                      setShowTenantDropdown(false);
                      setPage(1);
                    }}
                    className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 text-gray-900"
                  >
                    {tenant.name}
                  </button>
                ))}
                {filteredTenants.length === 0 && (
                  <div className="px-4 py-2 text-sm text-gray-500">No salons found</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin w-8 h-8 border-4 border-slate-800 border-t-transparent rounded-full"></div>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <p className="text-red-600">{error}</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">
                      User
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">
                      Salon
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">
                      Role
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase whitespace-nowrap">
                      Joined
                    </th>
                  </tr>
                </thead>
              <tbody className="divide-y divide-gray-200">
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                      No users found.
                    </td>
                  </tr>
                ) : (
                  users.map((user) => (
                    <tr key={user.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4">
                        <div className="flex items-center">
                          <div className="w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center">
                            <span className="text-sm font-medium text-slate-600">
                              {user.firstName?.[0] || ""}{user.lastName?.[0] || ""}
                            </span>
                          </div>
                          <div className="ml-3">
                            <div className="text-sm font-medium text-gray-900">
                              {user.firstName} {user.lastName}
                            </div>
                            <div className="text-sm text-gray-500">{user.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <Link
                          href={`/saas/tenants/${user.tenant?.id}`}
                          className="text-sm text-blue-600 hover:underline"
                        >
                          {user.tenant?.name || "N/A"}
                        </Link>
                      </td>
                      <td className="px-6 py-4">
                        {getRoleBadge(user.role)}
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          user.isActive ? "bg-indigo-100 text-indigo-800" : "bg-gray-100 text-gray-800"
                        }`}>
                          {user.isActive ? t("common.active") : t("common.inactive")}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-500">
                        {new Date(user.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-gray-500">
                Showing {(page - 1) * 10 + 1} to {Math.min(page * 10, total)} of {total} results
              </p>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setPage(page - 1)}
                  disabled={page === 1}
                  className="px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:opacity-50"
                >
                  Previous
                </button>
                <span className="text-sm">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage(page + 1)}
                  disabled={page === totalPages}
                  className="px-3 py-2 border border-gray-200 rounded-lg text-sm disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}