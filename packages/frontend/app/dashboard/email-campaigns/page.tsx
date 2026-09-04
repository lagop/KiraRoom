"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import {
  Mail,
  Plus,
  Send,
  Calendar,
  Users,
  Eye,
  MousePointer,
  XCircle,
  CheckCircle,
  Clock,
  Trash2,
  BarChart3,
  Edit,
  X,
  AlarmClock,
  UserPlus,
  Check,
  Play,
  Pause,
} from "lucide-react";
import {
  apiClient,
  EmailCampaign,
  CampaignStatus,
  CampaignType,
  Client,
  Promotion,
  CreateReengagementCampaignDto,
} from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useToast } from "@/components/ui/use-toast";

const statusColors: Record<CampaignStatus, string> = {
  draft: "bg-gray-100 text-gray-800",
  active: "bg-green-100 text-green-800",
  scheduled: "bg-blue-100 text-blue-800",
  sending: "bg-yellow-100 text-yellow-800",
  sent: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  failed: "bg-red-100 text-red-800",
};

// Campaign type labels using translations
const getCampaignTypeLabel = (type: CampaignType) => {
  const labels: Record<CampaignType, string> = {
    newsletter: "newsletter",
    promotion: "promotion",
    announcement: "announcement",
    reminder: "reminder",
    review_request: "review_request",
    loyalty: "loyalty",
    reengagement: "reengagement",
    custom: "custom",
  };
  return labels[type] || type;
};

export default function EmailCampaignsPage() {
  const t = useTranslations();
  const { toast } = useToast();
  const [campaigns, setCampaigns] = useState<EmailCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<EmailCampaign | null>(
    null,
  );
  const [filter, setFilter] = useState<string>("");
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [scheduleCampaignId, setScheduleCampaignId] = useState<string | null>(
    null,
  );
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");

  // Recipients modal state
  const [showRecipientsModal, setShowRecipientsModal] = useState(false);
  const [recipientsCampaignId, setRecipientsCampaignId] = useState<
    string | null
  >(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClients, setSelectedClients] = useState<string[]>([]);
  const [existingRecipients, setExistingRecipients] = useState<any[]>([]);
  const [loadingClients, setLoadingClients] = useState(false);

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({
    gender: "",
    minAge: "",
    maxAge: "",
    loyaltyTier: "",
    tags: "",
  });

  const [formData, setFormData] = useState({
    name: "",
    subject: "",
    previewText: "",
    content: "",
    campaignType: "newsletter" as CampaignType,
  });

  // Re-engagement campaign state
  const [showReengagementModal, setShowReengagementModal] = useState(false);
  const [reengagementData, setReengagementData] =
    useState<CreateReengagementCampaignDto>({
      name: "",
      subject: "",
      previewText: "",
      content: "",
      inactiveDaysThreshold: 30,
      linkedPromotionId: "",
      fromName: "",
      replyTo: "",
    });
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loadingPromotions, setLoadingPromotions] = useState(false);

  useEffect(() => {
    fetchCampaigns();
  }, [filter]);

  const fetchCampaigns = async () => {
    try {
      // Determine if filter is a status or campaignType
      const statusValues = [
        "draft",
        "active",
        "scheduled",
        "sending",
        "sent",
        "cancelled",
        "failed",
      ];
      const status = statusValues.includes(filter) ? filter : undefined;
      const campaignType =
        filter === "reengagement" ? "reengagement" : undefined;

      const data = await apiClient.getEmailCampaigns(status, campaignType);
      setCampaigns(data);
    } catch (error) {
      console.error("Error fetching campaigns:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingCampaign) {
        await apiClient.updateEmailCampaign(editingCampaign.id, formData);
      } else {
        await apiClient.createEmailCampaign(formData);
      }
      setShowModal(false);
      setEditingCampaign(null);
      setFormData({
        name: "",
        subject: "",
        previewText: "",
        content: "",
        campaignType: "newsletter",
      });
      fetchCampaigns();
    } catch (error) {
      console.error("Error saving campaign:", error);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("¿Estás seguro de que quieres eliminar esta campaña?")) return;
    try {
      await apiClient.deleteEmailCampaign(id);
      fetchCampaigns();
    } catch (error) {
      console.error("Error deleting campaign:", error);
    }
  };

  const handleSendNow = async (id: string) => {
    if (!confirm("¿Quieres enviar esta campaña ahora?")) return;
    try {
      await apiClient.sendEmailCampaignNow(id);
      fetchCampaigns();
    } catch (error) {
      console.error("Error sending campaign:", error);
    }
  };

  const handleSchedule = async () => {
    if (!scheduleCampaignId || !scheduleDate || !scheduleTime) {
      toast({
        title: t("email_campaigns.select_date_time"),
        variant: "destructive",
      });
      return;
    }
    const scheduledAt = new Date(
      `${scheduleDate}T${scheduleTime}`,
    ).toISOString();
    try {
      await apiClient.scheduleEmailCampaign(scheduleCampaignId, scheduledAt);
      fetchCampaigns();
      setShowScheduleModal(false);
      setScheduleCampaignId(null);
      setScheduleDate("");
      setScheduleTime("");
    } catch (error) {
      console.error("Error scheduling campaign:", error);
    }
  };

  // Re-engagement campaign handlers
  const openReengagementModal = async () => {
    setLoadingPromotions(true);
    setShowReengagementModal(true);
    try {
      const promotionsData = await apiClient.getAvailablePromotions();
      setPromotions(promotionsData.filter((p: Promotion) => p.isActive));
    } catch (error) {
      console.error("Error fetching promotions:", error);
    } finally {
      setLoadingPromotions(false);
    }
  };

  const handleCreateReengagement = async () => {
    if (
      !reengagementData.name ||
      !reengagementData.subject ||
      !reengagementData.content
    ) {
      toast({
        title: t("email_campaigns.complete_all_fields"),
        variant: "destructive",
      });
      return;
    }
    try {
      await apiClient.createReengagementCampaign(reengagementData);
      setShowReengagementModal(false);
      setReengagementData({
        name: "",
        subject: "",
        previewText: "",
        content: "",
        inactiveDaysThreshold: 30,
        linkedPromotionId: "",
        fromName: "",
        replyTo: "",
      });
      fetchCampaigns();
    } catch (error) {
      console.error("Error creating re-engagement campaign:", error);
    }
  };

  const handleActivateCampaign = async (id: string) => {
    if (
      !confirm(
        "¿Activar esta campaña de re-engagement? Se enviarán correos automáticamente a los clientes inactivos.",
      )
    )
      return;
    try {
      await apiClient.activateEmailCampaign(id);
      fetchCampaigns();
    } catch (error) {
      console.error("Error activating campaign:", error);
    }
  };

  const handleDeactivateCampaign = async (id: string) => {
    if (!confirm("¿Desactivar esta campaña?")) return;
    try {
      await apiClient.deactivateEmailCampaign(id);
      fetchCampaigns();
    } catch (error) {
      console.error("Error deactivating campaign:", error);
    }
  };

  const openRecipientsModal = async (campaignId: string) => {
    setRecipientsCampaignId(campaignId);
    setSelectedClients([]);
    setLoadingClients(true);
    setShowRecipientsModal(true);
    setFilters({
      gender: "",
      minAge: "",
      maxAge: "",
      loyaltyTier: "",
      tags: "",
    });

    try {
      // Get existing recipients for this campaign to pre-select them
      const existingRecipientsData =
        await apiClient.getEmailCampaignRecipients(campaignId);
      const existingClientIds = existingRecipientsData.map(
        (r: any) => r.clientId,
      );

      // Get all clients with email
      const clientsData = await apiClient.getClients();
      const clientsWithEmail = clientsData.filter((c: Client) => c.email);

      setClients(clientsWithEmail);
      setExistingRecipients(existingRecipientsData);

      // Pre-select clients that are already recipients of this campaign
      setSelectedClients(existingClientIds);
    } catch (error) {
      console.error("Error fetching clients:", error);
      // Fallback: show all clients if we can't check existing recipients
      try {
        const clientsData = await apiClient.getClients();
        setClients(clientsData.filter((c: Client) => c.email));
        setSelectedClients([]);
        setExistingRecipients([]);
      } catch (fallbackError) {
        console.error("Fallback error:", fallbackError);
      }
    } finally {
      setLoadingClients(false);
    }
  };

  const applyFilters = async () => {
    setLoadingClients(true);
    try {
      const filterParams: any = {};

      // Validate and set age filters
      const minAge = filters.minAge ? parseInt(filters.minAge) : undefined;
      const maxAge = filters.maxAge ? parseInt(filters.maxAge) : undefined;

      if (minAge !== undefined) {
        if (minAge < 0) {
          toast({
            title: t("email_campaigns.min_age_validation_min"),
            variant: "destructive",
          });
          setLoadingClients(false);
          return;
        }
        if (minAge > 120) {
          toast({
            title: t("email_campaigns.min_age_validation_max"),
            variant: "destructive",
          });
          setLoadingClients(false);
          return;
        }
        filterParams.minAge = minAge;
      }

      if (maxAge !== undefined) {
        if (maxAge < 0) {
          toast({
            title: t("email_campaigns.max_age_validation_min"),
            variant: "destructive",
          });
          setLoadingClients(false);
          return;
        }
        if (maxAge > 120) {
          toast({
            title: t("email_campaigns.max_age_validation_max"),
            variant: "destructive",
          });
          setLoadingClients(false);
          return;
        }
        filterParams.maxAge = maxAge;
      }

      // Validate age range
      if (minAge !== undefined && maxAge !== undefined && minAge > maxAge) {
        toast({
          title: t("email_campaigns.age_range_invalid"),
          variant: "destructive",
        });
        setLoadingClients(false);
        return;
      }

      if (filters.gender) filterParams.gender = filters.gender;
      if (filters.loyaltyTier) filterParams.loyaltyTier = filters.loyaltyTier;
      if (filters.tags)
        filterParams.tags = filters.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);

      // If any filter is applied, use filter endpoint, otherwise get all clients
      const hasFilters = Object.values(filterParams).some(
        (v) => v !== undefined && (Array.isArray(v) ? v.length > 0 : true),
      );

      if (hasFilters) {
        const filteredClients = await apiClient.filterClients(filterParams);
        setClients(filteredClients.filter((c: Client) => c.email));
      } else {
        const allClients = await apiClient.getClients();
        setClients(allClients.filter((c: Client) => c.email));
      }
    } catch (error) {
      console.error("Error applying filters:", error);
    } finally {
      setLoadingClients(false);
    }
  };

  const toggleClient = (clientId: string) => {
    setSelectedClients((prev) =>
      prev.includes(clientId)
        ? prev.filter((id) => id !== clientId)
        : [...prev, clientId],
    );
  };

  const selectAllClients = () => {
    if (selectedClients.length === clients.length) {
      setSelectedClients([]);
    } else {
      setSelectedClients(clients.map((c: Client) => c.id));
    }
  };

  const handleUpdateRecipients = async () => {
    if (!recipientsCampaignId) return;

    try {
      // Get existing recipients to calculate what's changed
      const existingRecipients =
        await apiClient.getEmailCampaignRecipients(recipientsCampaignId);
      const existingClientIds = existingRecipients.map((r: any) => r.clientId);

      // Calculate changes
      const newClientIds = selectedClients.filter(
        (id) => !existingClientIds.includes(id),
      );
      const removedClientIds = existingClientIds.filter(
        (id) => !selectedClients.includes(id),
      );

      // If no changes, just close the modal
      if (newClientIds.length === 0 && removedClientIds.length === 0) {
        toast({
          title: "Sin cambios",
          description:
            "No se han realizado modificaciones en los destinatarios",
          variant: "default",
        });
        setShowRecipientsModal(false);
        setRecipientsCampaignId(null);
        setSelectedClients([]);
        setExistingRecipients([]);
        return;
      }

      // Add new recipients
      if (newClientIds.length > 0) {
        await apiClient.addRecipientsToCampaign(
          recipientsCampaignId,
          newClientIds,
        );
      }

      // Remove unchecked recipients
      if (removedClientIds.length > 0) {
        await apiClient.removeRecipientsFromCampaign(
          recipientsCampaignId,
          removedClientIds,
        );
      }

      fetchCampaigns();
      setShowRecipientsModal(false);
      setRecipientsCampaignId(null);
      setSelectedClients([]);
      setExistingRecipients([]);

      // Create informative message
      const messages = [];
      if (newClientIds.length > 0)
        messages.push(`${newClientIds.length} añadidos`);
      if (removedClientIds.length > 0)
        messages.push(`${removedClientIds.length} eliminados`);

      toast({
        title: "Destinatarios actualizados",
        description:
          messages.join(", ") +
          `. Total: ${selectedClients.length} seleccionados`,
        variant: "default",
      });
    } catch (error) {
      console.error("Error updating recipients:", error);
      toast({
        title: "Error al actualizar destinatarios",
        variant: "destructive",
      });
    }
  };

  const handleSendToAll = async (campaignId: string) => {
    if (
      !confirm("¿Añadir todos los clientes como destinatarios y enviar ahora?")
    )
      return;
    try {
      // First add all clients as recipients
      const clientsData = await apiClient.getClients();
      const clientsWithEmail = clientsData.filter((c: Client) => c.email);

      if (clientsWithEmail.length === 0) {
        toast({
          title: t("email_campaigns.no_clients_with_email"),
          variant: "destructive",
        });
        return;
      }

      await apiClient.addRecipientsToCampaign(
        campaignId,
        clientsWithEmail.map((c: Client) => c.id),
      );

      // Then send immediately
      await apiClient.sendEmailCampaignNow(campaignId);
      fetchCampaigns();
      toast({
        title: t("email_campaigns.campaign_sent_to_clients", {
          count: clientsWithEmail.length,
        }),
        variant: "default",
      });
    } catch (error) {
      console.error("Error sending to all:", error);
    }
  };

  const openEditModal = (campaign: EmailCampaign) => {
    setEditingCampaign(campaign);
    setFormData({
      name: campaign.name,
      subject: campaign.subject,
      previewText: campaign.previewText || "",
      content: campaign.content,
      campaignType: campaign.campaignType,
    });
    setShowModal(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-purple-100 rounded-lg">
            <Mail className="w-6 h-6 text-purple-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 truncate">
              {t("email_campaigns.title")}
            </h1>
            <p className="text-gray-600">{t("email_campaigns.description")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={openReengagementModal}
            className="flex items-center px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors"
          >
            <UserPlus className="w-4 h-4 mr-2" />
            {t("email_campaigns.re_engagement")}
          </button>
          <button
            onClick={() => {
              setEditingCampaign(null);
              setFormData({
                name: "",
                subject: "",
                previewText: "",
                content: "",
                campaignType: "newsletter",
              });
              setShowModal(true);
            }}
            className="flex items-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
          >
            <Plus className="w-4 h-4 mr-2" />
            {t("email_campaigns.new_campaign")}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full sm:w-auto px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
        >
          <option value="">{t("email_campaigns.all_campaigns")}</option>
          <option value="draft">{t("email_campaigns.draft")}</option>
          <option value="active">{t("email_campaigns.active")}</option>
          <option value="scheduled">{t("email_campaigns.scheduled")}</option>
          <option value="sending">{t("email_campaigns.sending")}</option>
          <option value="sent">{t("email_campaigns.sent")}</option>
          <option value="reengagement">
            {t("email_campaigns.reengagement")}
          </option>
        </select>
      </div>

      {/* Campaigns List */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
        </div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-200">
          <Mail className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900">
            {t("email_campaigns.no_campaigns")}
          </h3>
          <p className="text-gray-500 mt-1">
            {t("email_campaigns.create_first_campaign")}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {campaigns.map((campaign) => (
            <div
              key={campaign.id}
              className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-gray-900">
                    {campaign.name}
                  </h3>
                  <p className="text-sm text-gray-500">{campaign.subject}</p>
                </div>
                <span
                  className={`px-2 py-1 rounded-full text-xs font-medium ${statusColors[campaign.status]}`}
                >
                  {campaign.status}
                </span>
              </div>

              <div className="flex items-center space-x-2 mb-4">
                <span className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded">
                  {t(
                    `email_campaigns.${getCampaignTypeLabel(campaign.campaignType)}`,
                  )}
                </span>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-5 gap-2 mb-4">
                <div className="text-center">
                  <div className="flex items-center justify-center">
                    <span title={t("email_campaigns.tooltip_recipients")}>
                      <Users className="w-4 h-4 text-gray-400" />
                    </span>
                  </div>
                  <p className="text-sm font-semibold">
                    {campaign.totalRecipients}
                  </p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center">
                    <span title={t("email_campaigns.tooltip_sent")}>
                      <Send className="w-4 h-4 text-blue-400" />
                    </span>
                  </div>
                  <p className="text-sm font-semibold">{campaign.emailsSent}</p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center">
                    <span title={t("email_campaigns.tooltip_opened")}>
                      <Eye className="w-4 h-4 text-green-400" />
                    </span>
                  </div>
                  <p className="text-sm font-semibold">
                    {campaign.emailsOpened}
                  </p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center">
                    <span title={t("email_campaigns.tooltip_clicks")}>
                      <MousePointer className="w-4 h-4 text-purple-400" />
                    </span>
                  </div>
                  <p className="text-sm font-semibold">{campaign.clicks}</p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center">
                    <span title={t("email_campaigns.tooltip_bounces")}>
                      <XCircle className="w-4 h-4 text-red-400" />
                    </span>
                  </div>
                  <p className="text-sm font-semibold">{campaign.bounces}</p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end space-x-2 pt-3 border-t border-gray-100">
                {campaign.status === "draft" && (
                  <>
                    <button
                      onClick={() => handleSendToAll(campaign.id)}
                      className="p-2 text-orange-600 hover:text-orange-700 hover:bg-orange-100 rounded-lg"
                      title={t("email_campaigns.send_to_all_clients")}
                    >
                      <Mail className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => openRecipientsModal(campaign.id)}
                      className="p-2 text-purple-600 hover:text-purple-700 hover:bg-purple-100 rounded-lg"
                      title={t("email_campaigns.add_recipients")}
                    >
                      <UserPlus className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => openEditModal(campaign)}
                      className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
                      title={t("email_campaigns.edit_tooltip")}
                    >
                      <Edit className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => {
                        setScheduleCampaignId(campaign.id);
                        setScheduleDate("");
                        setScheduleTime("");
                        setShowScheduleModal(true);
                      }}
                      className="p-2 text-blue-600 hover:text-blue-700 hover:bg-blue-100 rounded-lg"
                      title={t("email_campaigns.schedule_campaign")}
                    >
                      <AlarmClock className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleSendNow(campaign.id)}
                      className="p-2 text-green-600 hover:text-green-700 hover:bg-green-100 rounded-lg"
                      title={t("email_campaigns.send_now")}
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </>
                )}
                {campaign.status === "scheduled" && (
                  <div className="flex items-center text-blue-600 text-xs">
                    <Clock className="w-3 h-3 mr-1" />
                    {campaign.scheduledAt
                      ? new Date(campaign.scheduledAt).toLocaleString()
                      : t("email_campaigns.scheduled_for")}
                  </div>
                )}
                {/* Re-engagement campaign activation buttons */}
                {campaign.campaignType === "reengagement" &&
                  campaign.status === "draft" && (
                    <button
                      onClick={() => handleActivateCampaign(campaign.id)}
                      className="p-2 text-green-600 hover:text-green-700 hover:bg-green-100 rounded-lg"
                      title={t("email_campaigns.activate_campaign")}
                    >
                      <Play className="w-4 h-4" />
                    </button>
                  )}
                {campaign.campaignType === "reengagement" &&
                  campaign.status === "active" && (
                    <button
                      onClick={() => handleDeactivateCampaign(campaign.id)}
                      className="p-2 text-orange-600 hover:text-orange-700 hover:bg-orange-100 rounded-lg"
                      title={t("email_campaigns.deactivate_campaign")}
                    >
                      <Pause className="w-4 h-4" />
                    </button>
                  )}
                <button
                  onClick={() => handleDelete(campaign.id)}
                  className="p-2 text-red-600 hover:text-red-700 hover:bg-red-100 rounded-lg"
                  title={t("email_campaigns.delete_tooltip")}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">
                {editingCampaign ? "Editar Campaña" : "Nueva Campaña"}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("email_campaigns.campaign_name")}
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("email_campaigns.email_subject")}
                </label>
                <input
                  type="text"
                  value={formData.subject}
                  onChange={(e) =>
                    setFormData({ ...formData, subject: e.target.value })
                  }
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("email_campaigns.preview_text")}
                </label>
                <input
                  type="text"
                  value={formData.previewText}
                  onChange={(e) =>
                    setFormData({ ...formData, previewText: e.target.value })
                  }
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("email_campaigns.campaign_type")}
                </label>
                <select
                  value={formData.campaignType}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      campaignType: e.target.value as CampaignType,
                    })
                  }
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="newsletter">
                    {t("email_campaigns.newsletter")}
                  </option>
                  <option value="promotion">
                    {t("email_campaigns.promotion")}
                  </option>
                  <option value="announcement">
                    {t("email_campaigns.announcement")}
                  </option>
                  <option value="reminder">
                    {t("email_campaigns.reminder")}
                  </option>
                  <option value="review_request">
                    {t("email_campaigns.review_request")}
                  </option>
                  <option value="loyalty">
                    {t("email_campaigns.loyalty")}
                  </option>
                  <option value="custom">{t("email_campaigns.custom")}</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("email_campaigns.content_html")}
                </label>
                <textarea
                  value={formData.content}
                  onChange={(e) =>
                    setFormData({ ...formData, content: e.target.value })
                  }
                  rows={8}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 font-mono text-sm"
                  required
                  placeholder={t("email_campaigns.html_placeholder")}
                />
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
                >
                  {editingCampaign
                    ? t("email_campaigns.save_changes")
                    : t("email_campaigns.create_campaign")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Schedule Modal */}
      {showScheduleModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">Programar Campaña</h2>
              <button
                onClick={() => setShowScheduleModal(false)}
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Fecha
                </label>
                <input
                  type="date"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  min={new Date().toISOString().split("T")[0]}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Hora
                </label>
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={(e) => setScheduleTime(e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                  required
                />
              </div>

              <p className="text-sm text-gray-500">
                La campaña se enviará automáticamente en la fecha y hora
                especificadas.
              </p>
            </div>

            <div className="flex justify-end space-x-3 pt-4 mt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={() => setShowScheduleModal(false)}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleSchedule}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                Programar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Recipients Modal */}
      {showRecipientsModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold">Gestionar Destinatarios</h2>
                <p className="text-sm text-gray-500">
                  Selecciona los clientes que quieres incluir en la campaña
                </p>
              </div>
              <button
                onClick={() => setShowRecipientsModal(false)}
                className="p-2 hover:bg-gray-100 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Filters */}
            <div className="mb-4">
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="flex items-center text-sm text-purple-600 hover:text-purple-700 mb-2"
              >
                <Users className="w-4 h-4 mr-1" />
                {showFilters ? "Ocultar filtros" : "Mostrar filtros"}
              </button>

              {showFilters && (
                <div className="bg-gray-50 p-4 rounded-lg space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Género
                      </label>
                      <select
                        value={filters.gender}
                        onChange={(e) =>
                          setFilters({ ...filters, gender: e.target.value })
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      >
                        <option value="">Todos</option>
                        <option value="male">Masculino</option>
                        <option value="female">Femenino</option>
                        <option value="other">Otro</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Nivel de lealtad
                      </label>
                      <select
                        value={filters.loyaltyTier}
                        onChange={(e) =>
                          setFilters({
                            ...filters,
                            loyaltyTier: e.target.value,
                          })
                        }
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      >
                        <option value="">Todos</option>
                        <option value="bronze">Bronze</option>
                        <option value="silver">Silver</option>
                        <option value="gold">Gold</option>
                        <option value="platinum">Platinum</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Edad mínima
                      </label>
                      <input
                        type="number"
                        value={filters.minAge}
                        onChange={(e) =>
                          setFilters({ ...filters, minAge: e.target.value })
                        }
                        placeholder="18"
                        min={0}
                        max={120}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Edad máxima
                      </label>
                      <input
                        type="number"
                        value={filters.maxAge}
                        onChange={(e) =>
                          setFilters({ ...filters, maxAge: e.target.value })
                        }
                        placeholder="65"
                        min={0}
                        max={120}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Etiquetas (separadas por coma)
                    </label>
                    <input
                      type="text"
                      value={filters.tags}
                      onChange={(e) =>
                        setFilters({ ...filters, tags: e.target.value })
                      }
                      placeholder="vip, nuevo, frecuente"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    />
                  </div>
                  <button
                    onClick={applyFilters}
                    className="w-full px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm"
                  >
                    Aplicar filtros
                  </button>
                </div>
              )}
            </div>

            {loadingClients ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
              </div>
            ) : (
              <>
                <div className="mb-4 flex items-center justify-between">
                  <button
                    onClick={selectAllClients}
                    className="flex items-center text-sm text-purple-600 hover:text-purple-700"
                  >
                    <Check className="w-4 h-4 mr-1" />
                    {selectedClients.length === clients.length
                      ? "Deseleccionar todos"
                      : "Seleccionar todos"}
                  </button>
                  <div className="text-sm text-gray-500 space-y-1">
                    <div>
                      {selectedClients.length} de {clients.length} clientes
                      seleccionados
                    </div>
                    <div className="text-xs">
                      {(() => {
                        const existingClientIds = existingRecipients.map(
                          (r: any) => r.clientId,
                        );
                        const newCount = selectedClients.filter(
                          (id) => !existingClientIds.includes(id),
                        ).length;
                        const removedCount = existingClientIds.filter(
                          (id) => !selectedClients.includes(id),
                        ).length;

                        const parts = [];
                        parts.push(`${existingRecipients.length} ya añadidos`);
                        if (newCount > 0) parts.push(`${newCount} nuevos`);
                        if (removedCount > 0)
                          parts.push(`${removedCount} serán eliminados`);

                        return parts.join(" • ");
                      })()}
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto border border-gray-200 rounded-lg">
                  {clients.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      No hay clientes con correo electrónico
                    </div>
                  ) : (
                    <div className="divide-y divide-gray-200">
                      {clients.map((client: Client) => {
                        const isAlreadyRecipient = existingRecipients.some(
                          (r: any) => r.clientId === client.id,
                        );
                        return (
                          <label
                            key={client.id}
                            className={`flex items-center p-3 cursor-pointer hover:bg-gray-50 ${
                              selectedClients.includes(client.id)
                                ? "bg-purple-50"
                                : ""
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={selectedClients.includes(client.id)}
                              onChange={() => toggleClient(client.id)}
                              className="w-4 h-4 text-purple-600 rounded border-gray-300 focus:ring-purple-500"
                            />
                            <div className="ml-3 flex-1">
                              <div className="flex items-center justify-between">
                                <div>
                                  <p className="text-sm font-medium text-gray-900">
                                    {client.firstName} {client.lastName}
                                  </p>
                                  <p className="text-xs text-gray-500">
                                    {client.email}
                                  </p>
                                </div>
                                {isAlreadyRecipient && (
                                  <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded-full">
                                    Ya añadido
                                  </span>
                                )}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="flex justify-end space-x-3 pt-4 mt-4 border-t border-gray-200">
              <button
                type="button"
                onClick={() => setShowRecipientsModal(false)}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleUpdateRecipients}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
              >
                Actualizar Destinatarios
                {(() => {
                  const existingClientIds = existingRecipients.map(
                    (r: any) => r.clientId,
                  );
                  const newCount = selectedClients.filter(
                    (id) => !existingClientIds.includes(id),
                  ).length;
                  const removedCount = existingClientIds.filter(
                    (id) => !selectedClients.includes(id),
                  ).length;

                  if (newCount === 0 && removedCount === 0) {
                    return " (sin cambios)";
                  }

                  const changes = [];
                  if (newCount > 0) changes.push(`+${newCount} nuevos`);
                  if (removedCount > 0)
                    changes.push(`-${removedCount} eliminados`);

                  return ` (${changes.join(", ")})`;
                })()}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Re-engagement Campaign Modal */}
      {showReengagementModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-gray-200">
              <div>
                <h2 className="text-xl font-semibold text-gray-900">
                  Campaña de Re-engagement
                </h2>
                <p className="text-sm text-gray-500">
                  Envía recordatorios a clientes inactivos
                </p>
              </div>
              <button
                onClick={() => setShowReengagementModal(false)}
                className="text-gray-400 hover:text-gray-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleCreateReengagement();
              }}
              className="p-6 space-y-4"
            >
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nombre de la campaña *
                </label>
                <input
                  type="text"
                  value={reengagementData.name}
                  onChange={(e) =>
                    setReengagementData({
                      ...reengagementData,
                      name: e.target.value,
                    })
                  }
                  placeholder="Ej: Volvemos a verte"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Días de inactividad *
                  </label>
                  <select
                    value={reengagementData.inactiveDaysThreshold}
                    onChange={(e) =>
                      setReengagementData({
                        ...reengagementData,
                        inactiveDaysThreshold: parseInt(e.target.value),
                      })
                    }
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value={15}>15 días</option>
                    <option value={30}>30 días</option>
                    <option value={45}>45 días</option>
                    <option value={60}>60 días</option>
                    <option value={90}>90 días</option>
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Clientes sin visitar en{" "}
                    {reengagementData.inactiveDaysThreshold} días
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Promoción (opcional)
                  </label>
                  {loadingPromotions ? (
                    <div className="flex items-center justify-center py-2">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-orange-500"></div>
                    </div>
                  ) : (
                    <select
                      value={reengagementData.linkedPromotionId || ""}
                      onChange={(e) =>
                        setReengagementData({
                          ...reengagementData,
                          linkedPromotionId: e.target.value || undefined,
                        })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                    >
                      <option value="">Sin promoción</option>
                      {promotions.map((promo: Promotion) => (
                        <option key={promo.id} value={promo.id}>
                          {promo.name} ({promo.code}) -{" "}
                          {promo.type === "PERCENTAGE"
                            ? `${promo.value}%`
                            : `€${promo.value}`}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Asunto del email *
                </label>
                <input
                  type="text"
                  value={reengagementData.subject}
                  onChange={(e) =>
                    setReengagementData({
                      ...reengagementData,
                      subject: e.target.value,
                    })
                  }
                  placeholder="¡Te extrañamos! {{discountCode}}"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  {
                    "Usa {{clientName}}, {{salonName}}, {{discountCode}}, {{discountValue}} como placeholders"
                  }
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Vista previa
                </label>
                <input
                  type="text"
                  value={reengagementData.previewText || ""}
                  onChange={(e) =>
                    setReengagementData({
                      ...reengagementData,
                      previewText: e.target.value,
                    })
                  }
                  placeholder="Texto que aparece en la bandeja de entrada..."
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Contenido HTML *
                </label>
                <textarea
                  value={reengagementData.content}
                  onChange={(e) =>
                    setReengagementData({
                      ...reengagementData,
                      content: e.target.value,
                    })
                  }
                  placeholder="<h1>¡Hola {{clientName}}!</h1><p>Hace tiempo que no nos visitas...</p>"
                  rows={8}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 font-mono text-sm"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Nombre del remitente
                  </label>
                  <input
                    type="text"
                    value={reengagementData.fromName || ""}
                    onChange={(e) =>
                      setReengagementData({
                        ...reengagementData,
                        fromName: e.target.value,
                      })
                    }
                    placeholder="Tu Peluquería"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Responder a
                  </label>
                  <input
                    type="email"
                    value={reengagementData.replyTo || ""}
                    onChange={(e) =>
                      setReengagementData({
                        ...reengagementData,
                        replyTo: e.target.value,
                      })
                    }
                    placeholder="info@tupeluqueria.com"
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-4 border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => setShowReengagementModal(false)}
                  className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600"
                >
                  Crear Campaña
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
