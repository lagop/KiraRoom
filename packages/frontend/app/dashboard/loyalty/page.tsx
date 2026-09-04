"use client";

import { useState, useEffect } from "react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { Gift, Users, Star, Plus, Trash2, Edit, Award } from "lucide-react";

interface LoyaltyProgram {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  pointsPerEuro: number;
  pointsValueInCents: number;
  minPointsRedemption: number;
  welcomePoints: number;
  tiers: LoyaltyTier[];
  rewards: LoyaltyReward[];
  _count: { members: number; rewards: number };
}

interface LoyaltyTier {
  id: string;
  name: string;
  minPoints: number;
  pointsMultiplier: number;
}

interface LoyaltyReward {
  id: string;
  name: string;
  description: string;
  type: string;
  pointsCost: number;
  discountPercent: number;
  isActive: boolean;
}

interface LoyaltyMember {
  id: string;
  client: { firstName: string; lastName: string; email: string };
  currentPoints: number;
  lifetimePoints: number;
  totalSpent: number;
  status: string;
}

export default function LoyaltyPage() {
  const t = useTranslations();
  const [programs, setPrograms] = useState<LoyaltyProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"programs" | "members">(
    "programs",
  );
  const [selectedProgram, setSelectedProgram] = useState<LoyaltyProgram | null>(
    null,
  );
  const [members, setMembers] = useState<LoyaltyMember[]>([]);
  const [showProgramForm, setShowProgramForm] = useState(false);
  const [showRewardForm, setShowRewardForm] = useState(false);
  const [tenantId, setTenantId] = useState<string>("");

  useEffect(() => {
    const token = localStorage.getItem("kira_auth_token");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        setTenantId(payload.tenantId);
        loadPrograms(payload.tenantId);
      } catch (e) {
        console.error("Failed to decode token:", e);
      }
    }
  }, []);

  const loadPrograms = async (tenantId: string) => {
    try {
      setLoading(true);
      const data = await apiClient.getLoyaltyPrograms(tenantId);
      setPrograms(data);
    } catch (error) {
      console.error("Failed to load programs:", error);
    } finally {
      setLoading(false);
    }
  };

  const loadMembers = async (programId: string) => {
    try {
      const data = await apiClient.getLoyaltyMembers(programId);
      setMembers(data);
    } catch (error) {
      console.error("Failed to load members:", error);
    }
  };

  const handleCreateProgram = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    try {
      await apiClient.createLoyaltyProgram({
        tenantId,
        name: formData.get("name"),
        description: formData.get("description"),
        pointsPerEuro: parseInt(formData.get("pointsPerEuro") as string) || 1,
        pointsValueInCents:
          parseInt(formData.get("pointsValueInCents") as string) || 1,
        minPointsRedemption:
          parseInt(formData.get("minPointsRedemption") as string) || 100,
        welcomePoints: parseInt(formData.get("welcomePoints") as string) || 0,
      });
      await loadPrograms(tenantId);
      setShowProgramForm(false);
    } catch (error) {
      console.error("Failed to create program:", error);
    }
  };

  const handleCreateReward = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!selectedProgram) return;

    const formData = new FormData(e.currentTarget);

    try {
      await apiClient.createLoyaltyReward({
        programId: selectedProgram.id,
        name: formData.get("name"),
        description: formData.get("description"),
        type: formData.get("type"),
        pointsCost: parseInt(formData.get("pointsCost") as string),
        discountPercent:
          parseInt(formData.get("discountPercent") as string) || 0,
      });
      await loadPrograms(tenantId);
      setShowRewardForm(false);
    } catch (error) {
      console.error("Failed to create reward:", error);
    }
  };

  const handleDeleteProgram = async (id: string) => {
    if (!confirm("Are you sure you want to delete this program?")) return;

    try {
      await apiClient.deleteLoyaltyProgram(id);
      await loadPrograms(tenantId);
    } catch (error) {
      console.error("Failed to delete program:", error);
    }
  };

  const handleDeleteReward = async (id: string) => {
    if (!confirm(t("loyalty.confirm_delete_reward"))) return;

    try {
      await apiClient.deleteLoyaltyReward(id);
      if (selectedProgram) {
        const updated = await apiClient.getLoyaltyProgram(selectedProgram.id);
        setSelectedProgram(updated);
        setPrograms(programs.map((p) => (p.id === updated.id ? updated : p)));
      }
    } catch (error) {
      console.error("Failed to delete reward:", error);
    }
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">
            {t("loyalty.title")}
          </h1>
          <p className="text-gray-600">{t("loyalty.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setShowProgramForm(true)}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> {t("loyalty.new_program")}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex flex-wrap gap-x-8">
          <button
            onClick={() => setActiveTab("programs")}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === "programs"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            <Gift className="w-4 h-4 inline mr-2" />
            {t("loyalty.programs")}
          </button>
          <button
            onClick={() => setActiveTab("members")}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === "members"
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            <Users className="w-4 h-4 inline mr-2" />
            {t("loyalty.members")}
          </button>
        </nav>
      </div>

      {/* Programs Tab */}
      {activeTab === "programs" && (
        <div className="space-y-6">
          {programs.length === 0 ? (
            <div className="bg-white rounded-lg shadow p-12 text-center">
              <Gift className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                {t("loyalty.no_loyalty_programs")}
              </h3>
              <p className="text-gray-500 mb-4">
                {t("loyalty.create_first_program")}
              </p>
              <button
                onClick={() => setShowProgramForm(true)}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md"
              >
                {t("loyalty.create_program")}
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {programs.map((program) => (
                <div
                  key={program.id}
                  className="bg-white rounded-lg shadow p-6"
                >
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="text-lg font-semibold text-gray-900">
                        {program.name}
                      </h3>
                      <p className="text-sm text-gray-500">
                        {program.description}
                      </p>
                    </div>
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        program.isActive
                          ? "bg-green-100 text-green-800"
                          : "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {program.isActive
                        ? t("loyalty.active")
                        : t("loyalty.inactive")}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div>
                      <p className="text-xs text-gray-500">
                        {t("loyalty.points_per_euro")}
                      </p>
                      <p className="font-medium">{program.pointsPerEuro} pts</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">
                        {t("loyalty.welcome_points")}
                      </p>
                      <p className="font-medium">{program.welcomePoints} pts</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">
                        {t("loyalty.members_count")}
                      </p>
                      <p className="font-medium">
                        {program._count?.members || 0}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">
                        {t("loyalty.rewards_count")}
                      </p>
                      <p className="font-medium">
                        {program._count?.rewards || 0}
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setSelectedProgram(program);
                        loadMembers(program.id);
                        setActiveTab("members");
                      }}
                      className="text-blue-600 hover:text-blue-800 text-sm font-medium"
                    >
                      {t("loyalty.view_members")}
                    </button>
                    <button
                      onClick={() => {
                        setSelectedProgram(program);
                        setShowRewardForm(true);
                      }}
                      className="text-green-600 hover:text-green-800 text-sm font-medium"
                    >
                      {t("loyalty.add_reward")}
                    </button>
                    <button
                      onClick={() => handleDeleteProgram(program.id)}
                      className="text-red-600 hover:text-red-800 text-sm font-medium"
                    >
                      {t("loyalty.delete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Members Tab */}
      {activeTab === "members" && (
        <div className="space-y-6">
          {programs.length > 0 && (
            <div className="bg-white rounded-lg shadow p-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                {t("loyalty.select_program")}
              </label>
              <select
                value={selectedProgram?.id || ""}
                onChange={async (e) => {
                  const prog = programs.find((p) => p.id === e.target.value);
                  if (prog) {
                    setSelectedProgram(prog);
                    await loadMembers(prog.id);
                  }
                }}
                className="w-full max-w-md px-3 py-2 border border-gray-300 rounded-md"
              >
                <option value="">{t("loyalty.select_a_program")}</option>
                {programs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {selectedProgram && members.length === 0 && (
            <div className="bg-white rounded-lg shadow p-12 text-center">
              <Users className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                {t("loyalty.no_members_yet")}
              </h3>
              <p className="text-gray-500">
                {t("loyalty.customers_will_appear")}
              </p>
            </div>
          )}

          {members.length > 0 && (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="overflow-x-auto">
              <table className="min-w-[720px] w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      {t("loyalty.customer")}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      {t("loyalty.points")}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      {t("loyalty.lifetime")}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      {t("loyalty.total_spent")}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                      {t("loyalty.status")}
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {members.map((member) => (
                    <tr key={member.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4">
                        <div className="text-sm font-medium text-gray-900">
                          {member.client.firstName} {member.client.lastName}
                        </div>
                        <div className="text-sm text-gray-500">
                          {member.client.email}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <Star className="w-4 h-4 text-yellow-500" />
                          <span className="font-medium">
                            {member.currentPoints}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {member.lifetimePoints}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        €{member.totalSpent.toFixed(2)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`px-2 py-1 rounded text-xs font-medium ${
                            member.status === "active"
                              ? "bg-green-100 text-green-800"
                              : "bg-gray-100 text-gray-800"
                          }`}
                        >
                          {member.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Program Modal */}
      {showProgramForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-semibold mb-4">
              {t("loyalty.create_loyalty_program")}
            </h2>
            <form onSubmit={handleCreateProgram}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t("loyalty.program_name")}
                  </label>
                  <input
                    name="name"
                    required
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t("loyalty.description")}
                  </label>
                  <textarea
                    name="description"
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("loyalty.points_per_euro")}
                    </label>
                    <input
                      name="pointsPerEuro"
                      type="number"
                      defaultValue={1}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("loyalty.welcome_points")}
                    </label>
                    <input
                      name="welcomePoints"
                      type="number"
                      defaultValue={0}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("loyalty.min_redemption")}
                    </label>
                    <input
                      name="minPointsRedemption"
                      type="number"
                      defaultValue={100}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("loyalty.point_value_cents")}
                    </label>
                    <input
                      name="pointsValueInCents"
                      type="number"
                      defaultValue={1}
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setShowProgramForm(false)}
                  className="px-4 py-2 border border-gray-300 rounded-md"
                >
                  {t("loyalty.cancel")}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-md"
                >
                  {t("loyalty.create")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create Reward Modal */}
      {showRewardForm && selectedProgram && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-semibold mb-4">
              {t("loyalty.add_reward_to")} {selectedProgram.name}
            </h2>
            <form onSubmit={handleCreateReward}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t("loyalty.reward_name")}
                  </label>
                  <input
                    name="name"
                    required
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t("loyalty.description")}
                  </label>
                  <textarea
                    name="description"
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("loyalty.type")}
                    </label>
                    <select
                      name="type"
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                    >
                      <option value="discount">
                        {t("loyalty.reward_type_discount")}
                      </option>
                      <option value="free_service">
                        {t("loyalty.reward_type_free_service")}
                      </option>
                      <option value="product">
                        {t("loyalty.reward_type_product")}
                      </option>
                      <option value="voucher">
                        {t("loyalty.reward_type_voucher")}
                      </option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      {t("loyalty.points_cost")}
                    </label>
                    <input
                      name="pointsCost"
                      type="number"
                      required
                      className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    {t("loyalty.discount_percent")}
                  </label>
                  <input
                    name="discountPercent"
                    type="number"
                    defaultValue={0}
                    className="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setShowRewardForm(false)}
                  className="px-4 py-2 border border-gray-300 rounded-md"
                >
                  {t("loyalty.cancel")}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-blue-600 text-white rounded-md"
                >
                  {t("loyalty.add_reward_button")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
