"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Mail,
  Plus,
  Send,
  Users,
  Eye,
  MousePointer,
  XCircle,
  Clock,
  Trash2,
  Edit,
  X,
  AlarmClock,
  UserPlus,
  Check,
  Play,
  Pause,
  Archive,
  ArchiveRestore,
  RotateCcw,
  CalendarX,
  Lock,
} from "lucide-react";
import {
  apiClient,
  EmailCampaign,
  EmailCampaignAudience,
  EmailCampaignTrackingStatus,
  SendEmailCampaignResult,
  CampaignStatus,
  CampaignType,
  Client,
  Promotion,
  CreateReengagementCampaignDto,
} from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  EXCLUSION_LABELS,
  campaignActions,
  campaignProgress,
  campaignStatusLabel,
  errorMessage,
  exclusionSummary,
  formatSalonDateTime,
  isPlanBlocked,
  optionalText,
  scheduledInstantIso,
  sendConfirmText,
} from "@/lib/email-campaigns";
import { discountLabel } from "@/lib/promotions-format";

const statusColors: Record<CampaignStatus, string> = {
  draft: "bg-gray-100 text-gray-800",
  active: "bg-green-100 text-green-800",
  scheduled: "bg-blue-100 text-blue-800",
  sending: "bg-yellow-100 text-yellow-800",
  sent: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  failed: "bg-red-100 text-red-800",
};

/**
 * The picker lists every client with an email. Those who cannot receive
 * campaigns (no completed visit, said no to promotions, unsubscribed or
 * bounced, not active) are marked with the reason from GET
 * /email-campaigns/audience and cannot be ticked; the server leaves them out
 * when recipients are added and again when it sends.
 */
const withEmail = (c: Client) => !!c.email;

const EMPTY_AUDIENCE: EmailCampaignAudience = {
  reachable: 0,
  excluded: { inactive: 0, no_email: 0, refused: 0, suppressed: 0, no_visit: 0 },
  clients: {},
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

// What a campaign card's buttons ask before doing; the copy lives under
// email_campaigns.confirm.<action>.
type CampaignAction =
  | "delete"
  | "send"
  | "sendAll"
  | "activate"
  | "deactivate"
  | "unschedule"
  | "archive"
  | "unarchive"
  | "retryFailed";

const EMPTY_FORM = {
  name: "",
  subject: "",
  previewText: "",
  content: "",
  replyTo: "",
  campaignType: "newsletter" as CampaignType,
};

const EMPTY_REENGAGEMENT: CreateReengagementCampaignDto = {
  name: "",
  subject: "",
  previewText: "",
  content: "",
  inactiveDaysThreshold: 30,
  linkedPromotionId: "",
  replyTo: "",
};

/** Today on the salon's clock, as the date input wants it (YYYY-MM-DD). */
const salonToday = (timeZone: string) =>
  new Date().toLocaleDateString("en-CA", { timeZone });

export default function EmailCampaignsPage() {
  const t = useTranslations();
  const { toast } = useToast();
  // The action a campaign button is about to take, confirmed in the panel's
  // dialog before it runs.
  const [pendingAction, setPendingAction] = useState<{
    action: CampaignAction;
    campaign: EmailCampaign;
  } | null>(null);
  const [performingAction, setPerformingAction] = useState(false);
  const [campaigns, setCampaigns] = useState<EmailCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  // The plan does not include campaigns (403 FEATURE_NOT_IN_PLAN): the page
  // says so and links to Facturación instead of showing an empty list.
  const [planBlocked, setPlanBlocked] = useState(false);
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

  // The schedule and the dates shown are the salon's clock, not the browser's.
  const tenant = useQuery({
    queryKey: ["auth", "tenant"],
    queryFn: () => apiClient.getTenant(),
    staleTime: 5 * 60 * 1000,
  });
  const timeZone = tenant.data?.timezone || "Europe/Madrid";

  // Recipients modal state
  const [showRecipientsModal, setShowRecipientsModal] = useState(false);
  const [recipientsCampaignId, setRecipientsCampaignId] = useState<
    string | null
  >(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [audience, setAudience] =
    useState<EmailCampaignAudience>(EMPTY_AUDIENCE);
  const [selectedClients, setSelectedClients] = useState<string[]>([]);
  const [existingRecipients, setExistingRecipients] = useState<any[]>([]);
  const [loadingClients, setLoadingClients] = useState(false);
  const exclusionOf = (clientId: string) => audience.clients[clientId];

  // Filter state
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState({
    gender: "",
    minAge: "",
    maxAge: "",
    tags: "",
  });

  const [formData, setFormData] = useState(EMPTY_FORM);

  // Re-engagement campaign state
  const [showReengagementModal, setShowReengagementModal] = useState(false);
  const [reengagementData, setReengagementData] =
    useState<CreateReengagementCampaignDto>(EMPTY_REENGAGEMENT);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loadingPromotions, setLoadingPromotions] = useState(false);

  // Opens, clicks and bounces only exist if Resend's webhook reaches the
  // server. Without it they would read 0 forever, which looks like a real
  // result; the cards show "—" and a banner says what is missing.
  const [tracking, setTracking] = useState<EmailCampaignTrackingStatus | null>(
    null,
  );
  useEffect(() => {
    apiClient
      .getEmailCampaignTrackingStatus()
      .then(setTracking)
      .catch(() => setTracking(null));
  }, []);
  const trackingOff = tracking !== null && !tracking.trackingConfigured;
  const tracked = (value: number) => (trackingOff ? "—" : value);

  useEffect(() => {
    fetchCampaigns();
  }, [filter]);

  // Sending happens in the background, a batch a minute: while a campaign
  // is going out its card refreshes so the progress line moves.
  const anySending = campaigns.some((c) => c.status === "sending");
  useEffect(() => {
    if (!anySending) return;
    const id = setInterval(() => fetchCampaigns(), 15_000);
    return () => clearInterval(id);
  }, [anySending, filter]);

  const toastError = (title: string, error: unknown) => {
    toast({
      title,
      description: errorMessage(error),
      variant: "destructive",
    });
  };

  /** The send is queued: the emails go out little by little. */
  const toastQueued = (result: SendEmailCampaignResult) => {
    toast({
      title: "Campaña en marcha",
      description:
        result.queued === 1
          ? "1 email en cola. El avance se ve en la tarjeta."
          : `${result.queued} emails en cola. Salen poco a poco; el avance se ve en la tarjeta.`,
    });
  };

  const fetchCampaigns = async () => {
    try {
      // The filter is a status, the re-engagement type or the archived list.
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
      const archived = filter === "archived" ? true : undefined;

      const data = await apiClient.getEmailCampaigns(
        status,
        campaignType,
        archived,
      );
      setCampaigns(data);
      setPlanBlocked(false);
    } catch (error) {
      if (isPlanBlocked(error)) {
        setPlanBlocked(true);
      } else {
        toastError("No se pudieron cargar las campañas", error);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Empty optional fields are left out, not sent as "".
    const payload = {
      name: formData.name,
      subject: formData.subject,
      content: formData.content,
      campaignType: formData.campaignType,
      previewText: optionalText(formData.previewText),
      replyTo: optionalText(formData.replyTo),
    };
    try {
      if (editingCampaign) {
        await apiClient.updateEmailCampaign(editingCampaign.id, payload);
      } else {
        await apiClient.createEmailCampaign(payload);
      }
      setShowModal(false);
      setEditingCampaign(null);
      setFormData(EMPTY_FORM);
      fetchCampaigns();
    } catch (error) {
      toastError("No se pudo guardar la campaña", error);
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
    // 10:30 means 10:30 on the salon's clock, wherever the browser is.
    const scheduledAt = scheduledInstantIso(scheduleDate, scheduleTime, timeZone);
    try {
      await apiClient.scheduleEmailCampaign(scheduleCampaignId, scheduledAt);
      fetchCampaigns();
      setShowScheduleModal(false);
      setScheduleCampaignId(null);
      setScheduleDate("");
      setScheduleTime("");
      toast({
        title: "Campaña programada",
        description: formatSalonDateTime(scheduledAt, timeZone),
      });
    } catch (error) {
      toastError("No se pudo programar la campaña", error);
    }
  };

  // Re-engagement campaign handlers
  const openReengagementModal = async () => {
    setLoadingPromotions(true);
    setShowReengagementModal(true);
    try {
      // The server lists only active promotions that have not ended.
      const promotionsData = await apiClient.getAvailablePromotions();
      setPromotions(promotionsData.filter((p: Promotion) => p.isActive));
    } catch (error) {
      setPromotions([]);
      toastError("No se pudieron cargar las promociones", error);
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
      await apiClient.createReengagementCampaign({
        name: reengagementData.name,
        subject: reengagementData.subject,
        content: reengagementData.content,
        inactiveDaysThreshold: reengagementData.inactiveDaysThreshold,
        previewText: optionalText(reengagementData.previewText),
        linkedPromotionId: optionalText(reengagementData.linkedPromotionId),
        replyTo: optionalText(reengagementData.replyTo),
      });
      setShowReengagementModal(false);
      setReengagementData(EMPTY_REENGAGEMENT);
      fetchCampaigns();
    } catch (error) {
      toastError("No se pudo crear la campaña", error);
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
      tags: "",
    });

    try {
      const [existingRecipientsData, clientsData, audienceData] =
        await Promise.all([
          apiClient.getEmailCampaignRecipients(campaignId),
          apiClient.getClients(),
          apiClient.getEmailCampaignAudience(),
        ]);
      setClients(clientsData.filter(withEmail));
      setAudience(audienceData);
      setExistingRecipients(existingRecipientsData);
      // Pre-select clients that are already recipients of this campaign
      setSelectedClients(existingRecipientsData.map((r: any) => r.clientId));
    } catch (error) {
      setClients([]);
      setAudience(EMPTY_AUDIENCE);
      setExistingRecipients([]);
      toastError("No se pudieron cargar las clientas", error);
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
        setClients(filteredClients.filter(withEmail));
      } else {
        const allClients = await apiClient.getClients();
        setClients(allClients.filter(withEmail));
      }
    } catch (error) {
      toastError("No se pudieron aplicar los filtros", error);
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

  // "Seleccionar todas" ticks only those who can receive it.
  const selectableClients = clients.filter((c) => !exclusionOf(c.id));
  const allSelectableSelected =
    selectableClients.length > 0 &&
    selectableClients.every((c) => selectedClients.includes(c.id));
  const selectAllClients = () => {
    if (allSelectableSelected) {
      setSelectedClients([]);
    } else {
      setSelectedClients(selectableClients.map((c: Client) => c.id));
    }
  };

  const closeRecipientsModal = () => {
    setShowRecipientsModal(false);
    setRecipientsCampaignId(null);
    setSelectedClients([]);
    setExistingRecipients([]);
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
          description: "No has cambiado las destinatarias",
          variant: "default",
        });
        closeRecipientsModal();
        return;
      }

      // The server says how many it really added: those who cannot receive
      // campaigns are left out.
      let added = 0;
      let excluded = 0;
      if (newClientIds.length > 0) {
        const result = await apiClient.addRecipientsToCampaign(
          recipientsCampaignId,
          newClientIds,
        );
        added = result.added;
        excluded = result.excluded;
      }

      if (removedClientIds.length > 0) {
        await apiClient.removeRecipientsFromCampaign(
          recipientsCampaignId,
          removedClientIds,
        );
      }

      fetchCampaigns();
      closeRecipientsModal();

      const messages = [];
      if (newClientIds.length > 0)
        messages.push(added === 1 ? "1 añadida" : `${added} añadidas`);
      if (excluded > 0)
        messages.push(
          excluded === 1
            ? "1 no puede recibir campañas y no se ha añadido"
            : `${excluded} no pueden recibir campañas y no se han añadido`,
        );
      if (removedClientIds.length > 0)
        messages.push(
          removedClientIds.length === 1
            ? "1 quitada"
            : `${removedClientIds.length} quitadas`,
        );

      toast({
        title: "Destinatarias actualizadas",
        description: messages.join(", ") + ".",
        variant: "default",
      });
    } catch (error) {
      toastError("No se pudieron actualizar las destinatarias", error);
    }
  };

  // What each confirmed action does, and what the toast says when it worked.
  const actionRunners: Record<
    CampaignAction,
    { run: (id: string) => Promise<unknown>; failed: string; done?: string }
  > = {
    delete: {
      run: (id) => apiClient.deleteEmailCampaign(id),
      failed: "No se pudo eliminar la campaña",
      done: "Campaña eliminada",
    },
    send: {
      run: async (id) => toastQueued(await apiClient.sendEmailCampaignNow(id)),
      failed: "No se pudo enviar la campaña",
    },
    sendAll: {
      // The server adds every client who can receive it, then sends.
      run: async (id) => toastQueued(await apiClient.sendEmailCampaignToAll(id)),
      failed: "No se pudo enviar la campaña",
    },
    activate: {
      run: (id) => apiClient.activateEmailCampaign(id),
      failed: "No se pudo activar la campaña",
      done: "Campaña activada",
    },
    deactivate: {
      run: (id) => apiClient.deactivateEmailCampaign(id),
      failed: "No se pudo desactivar la campaña",
      done: "Campaña desactivada",
    },
    unschedule: {
      run: (id) => apiClient.unscheduleEmailCampaign(id),
      failed: "No se pudo desprogramar la campaña",
      done: "La campaña vuelve a borrador",
    },
    archive: {
      run: (id) => apiClient.archiveEmailCampaign(id),
      failed: "No se pudo archivar la campaña",
      done: "Campaña archivada",
    },
    unarchive: {
      run: (id) => apiClient.unarchiveEmailCampaign(id),
      failed: "No se pudo desarchivar la campaña",
      done: "Campaña desarchivada",
    },
    retryFailed: {
      run: async (id) => toastQueued(await apiClient.retryFailedEmailCampaign(id)),
      failed: "No se pudieron reintentar los envíos",
    },
  };

  const performPendingAction = async () => {
    if (!pendingAction) return;
    const { action, campaign } = pendingAction;
    const runner = actionRunners[action];
    setPerformingAction(true);
    try {
      await runner.run(campaign.id);
      if (runner.done) toast({ title: runner.done });
    } catch (error) {
      toastError(runner.failed, error);
    } finally {
      setPerformingAction(false);
      setPendingAction(null);
      fetchCampaigns();
    }
  };

  const confirmDescription = (action: CampaignAction, campaign: EmailCampaign) => {
    if (action === "send" || action === "sendAll") {
      return sendConfirmText(action, campaign.pendingCount ?? campaign.totalRecipients);
    }
    return t(`email_campaigns.confirm.${action}.description`);
  };

  const openEditModal = (campaign: EmailCampaign) => {
    setEditingCampaign(campaign);
    setFormData({
      name: campaign.name,
      subject: campaign.subject,
      previewText: campaign.previewText || "",
      content: campaign.content,
      replyTo: campaign.replyTo || "",
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
        {!planBlocked && (
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
                setFormData(EMPTY_FORM);
                setShowModal(true);
              }}
              className="flex items-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
            >
              <Plus className="w-4 h-4 mr-2" />
              {t("email_campaigns.new_campaign")}
            </button>
          </div>
        )}
      </div>

      {planBlocked && (
        <div className="rounded-xl border border-purple-200 bg-purple-50 p-6">
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-purple-600" />
            <div className="space-y-2">
              <h2 className="font-semibold text-gray-900">
                {t("email_campaigns.plan_blocked_title")}
              </h2>
              <p className="text-sm text-gray-700">
                {t("email_campaigns.plan_blocked_body")}
              </p>
              <Link
                href="/dashboard/billing"
                className="inline-flex items-center rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
              >
                {t("email_campaigns.plan_blocked_cta")}
              </Link>
            </div>
          </div>
        </div>
      )}

      {!planBlocked && tracking && !tracking.sendingConfigured && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          El envío de emails no está activado en el servidor: las campañas no
          se pueden enviar todavía.
        </div>
      )}
      {!planBlocked && trackingOff && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Las aperturas, los clics y los rebotes aún no se registran: falta
          conectar el aviso de entregas del proveedor de email. Hasta entonces
          solo se cuentan los emails enviados.
        </div>
      )}
      {!planBlocked && tracking && tracking.suppressedAddresses > 0 && (
        <p className="text-sm text-gray-600">
          {tracking.suppressedAddresses === 1
            ? "1 dirección ya no recibe tus campañas"
            : `${tracking.suppressedAddresses} direcciones ya no reciben tus campañas`}{" "}
          (se dieron de baja, rebote permanente o la marcaron como spam).
        </p>
      )}

      {!planBlocked && (
      <>
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
          <option value="archived">{t("email_campaigns.archived")}</option>
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
            {filter === "archived"
              ? t("email_campaigns.no_archived_campaigns")
              : t("email_campaigns.no_campaigns")}
          </h3>
          {filter !== "archived" && (
            <p className="text-gray-500 mt-1">
              {t("email_campaigns.create_first_campaign")}
            </p>
          )}
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
                  {campaignStatusLabel(campaign.status)}
                </span>
              </div>

              <div className="flex items-center space-x-2 mb-4">
                <span className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded">
                  {t(
                    `email_campaigns.${getCampaignTypeLabel(campaign.campaignType)}`,
                  )}
                </span>
                {campaign.archivedAt && (
                  <span className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded">
                    {t("email_campaigns.archived")}
                  </span>
                )}
              </div>

              {(() => {
                const progress = campaignProgress(campaign);
                return progress ? (
                  <p
                    className={`mb-4 text-xs ${
                      campaign.status === "sending"
                        ? "text-yellow-700"
                        : "text-red-700"
                    }`}
                  >
                    {progress}
                  </p>
                ) : null;
              })()}

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
                    {tracked(campaign.emailsOpened)}
                  </p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center">
                    <span title={t("email_campaigns.tooltip_clicks")}>
                      <MousePointer className="w-4 h-4 text-purple-400" />
                    </span>
                  </div>
                  <p className="text-sm font-semibold">
                    {tracked(campaign.clicks)}
                  </p>
                </div>
                <div className="text-center">
                  <div className="flex items-center justify-center">
                    <span title={t("email_campaigns.tooltip_bounces")}>
                      <XCircle className="w-4 h-4 text-red-400" />
                    </span>
                  </div>
                  <p className="text-sm font-semibold">
                    {tracked(campaign.bounces)}
                  </p>
                </div>
              </div>

              {/* Actions: which ones a campaign offers is in lib/email-campaigns.ts */}
              {(() => {
                const can = campaignActions(campaign);
                const ask = (action: CampaignAction) => () =>
                  setPendingAction({ action, campaign });
                return (
                  <div className="flex flex-wrap items-center justify-end gap-1 pt-3 border-t border-gray-100">
                    {campaign.status === "scheduled" && campaign.scheduledAt && (
                      <div className="mr-auto flex items-center text-blue-600 text-xs">
                        <Clock className="w-3 h-3 mr-1 shrink-0" />
                        {formatSalonDateTime(campaign.scheduledAt, timeZone)}
                      </div>
                    )}
                    {can.sendToAll && (
                      <button
                        onClick={ask("sendAll")}
                        className="p-2 text-orange-600 hover:text-orange-700 hover:bg-orange-100 rounded-lg"
                        title={t("email_campaigns.send_to_all_clients")}
                      >
                        <Mail className="w-4 h-4" />
                      </button>
                    )}
                    {can.recipients && (
                      <button
                        onClick={() => openRecipientsModal(campaign.id)}
                        className="p-2 text-purple-600 hover:text-purple-700 hover:bg-purple-100 rounded-lg"
                        title={t("email_campaigns.add_recipients")}
                      >
                        <UserPlus className="w-4 h-4" />
                      </button>
                    )}
                    {can.edit && (
                      <button
                        onClick={() => openEditModal(campaign)}
                        className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
                        title={t("email_campaigns.edit_tooltip")}
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                    )}
                    {can.schedule && (
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
                    )}
                    {can.sendNow && (
                      <button
                        onClick={ask("send")}
                        className="p-2 text-green-600 hover:text-green-700 hover:bg-green-100 rounded-lg"
                        title={t("email_campaigns.send_now")}
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    )}
                    {can.unschedule && (
                      <button
                        onClick={ask("unschedule")}
                        className="p-2 text-blue-600 hover:text-blue-700 hover:bg-blue-100 rounded-lg"
                        title={t("email_campaigns.unschedule")}
                      >
                        <CalendarX className="w-4 h-4" />
                      </button>
                    )}
                    {can.activate && (
                      <button
                        onClick={ask("activate")}
                        className="p-2 text-green-600 hover:text-green-700 hover:bg-green-100 rounded-lg"
                        title={t("email_campaigns.activate_campaign")}
                      >
                        <Play className="w-4 h-4" />
                      </button>
                    )}
                    {can.deactivate && (
                      <button
                        onClick={ask("deactivate")}
                        className="p-2 text-orange-600 hover:text-orange-700 hover:bg-orange-100 rounded-lg"
                        title={t("email_campaigns.deactivate_campaign")}
                      >
                        <Pause className="w-4 h-4" />
                      </button>
                    )}
                    {can.retryFailed && (
                      <button
                        onClick={ask("retryFailed")}
                        className="p-2 text-yellow-700 hover:text-yellow-800 hover:bg-yellow-100 rounded-lg"
                        title={t("email_campaigns.retry_failed")}
                      >
                        <RotateCcw className="w-4 h-4" />
                      </button>
                    )}
                    {can.archive && (
                      <button
                        onClick={ask("archive")}
                        className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
                        title={t("email_campaigns.archive_tooltip")}
                      >
                        <Archive className="w-4 h-4" />
                      </button>
                    )}
                    {can.unarchive && (
                      <button
                        onClick={ask("unarchive")}
                        className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
                        title={t("email_campaigns.unarchive_tooltip")}
                      >
                        <ArchiveRestore className="w-4 h-4" />
                      </button>
                    )}
                    {can.delete && (
                      <button
                        onClick={ask("delete")}
                        className="p-2 text-red-600 hover:text-red-700 hover:bg-red-100 rounded-lg"
                        title={t("email_campaigns.delete_tooltip")}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      )}
      </>
      )}

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold">
                {editingCampaign
                  ? t("email_campaigns.edit_campaign")
                  : t("email_campaigns.new_campaign")}
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
                <p className="mt-1 text-xs text-gray-500">
                  {t("email_campaigns.preview_text_hint")}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("email_campaigns.reply_to")}
                </label>
                <input
                  type="email"
                  value={formData.replyTo}
                  onChange={(e) =>
                    setFormData({ ...formData, replyTo: e.target.value })
                  }
                  placeholder={tenant.data?.email || ""}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  {t("email_campaigns.reply_to_hint")}{" "}
                  {t("email_campaigns.sender_note")}
                </p>
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
                <p className="mt-1 text-xs text-gray-500">{t("email_campaigns.unsubscribe_note")}</p>
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
              <h2 className="text-xl font-bold">
                {t("email_campaigns.schedule_campaign")}
              </h2>
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
                  min={salonToday(timeZone)}
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
                La campaña empezará a enviarse sola en esa fecha y hora.{" "}
                {t("email_campaigns.schedule_hint", { timezone: timeZone })}
                {scheduleDate && scheduleTime && (
                  <>
                    {" "}
                    Se enviará el{" "}
                    {formatSalonDateTime(
                      scheduledInstantIso(scheduleDate, scheduleTime, timeZone),
                      timeZone,
                    )}
                    .
                  </>
                )}
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
                <h2 className="text-xl font-bold">Destinatarias</h2>
                <p className="text-sm text-gray-500">
                  Elige las clientas que recibirán la campaña. Solo pueden
                  recibirla las que han venido al menos una vez y aceptan
                  promociones.
                </p>
                {exclusionSummary(audience.excluded) && (
                  <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {exclusionSummary(audience.excluded)}
                  </p>
                )}
              </div>
              <button
                onClick={closeRecipientsModal}
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
                    {/* No "nivel de lealtad" filter: clients.loyaltyTier is
                        never computed (every client reads "bronze"); the
                        loyalty programme's levels live on its members. */}
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
                    {allSelectableSelected
                      ? "Quitar todas"
                      : "Seleccionar todas"}
                  </button>
                  <div className="text-sm text-gray-500 space-y-1">
                    <div>
                      {selectedClients.length} de {selectableClients.length}{" "}
                      seleccionadas
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
                        parts.push(`${existingRecipients.length} ya añadidas`);
                        if (newCount > 0) parts.push(`${newCount} nuevas`);
                        if (removedCount > 0)
                          parts.push(`${removedCount} se quitarán`);

                        return parts.join(" • ");
                      })()}
                    </div>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto border border-gray-200 rounded-lg">
                  {clients.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">
                      {t("email_campaigns.no_clients_with_email")}
                    </div>
                  ) : (
                    <div className="divide-y divide-gray-200">
                      {clients.map((client: Client) => {
                        const isAlreadyRecipient = existingRecipients.some(
                          (r: any) => r.clientId === client.id,
                        );
                        const exclusion = exclusionOf(client.id);
                        const checked = selectedClients.includes(client.id);
                        // An excluded client can be unticked (taken off the
                        // list) but not ticked.
                        const locked = !!exclusion && !checked;
                        return (
                          <label
                            key={client.id}
                            className={`flex items-center p-3 ${
                              locked
                                ? "cursor-not-allowed opacity-60"
                                : "cursor-pointer hover:bg-gray-50"
                            } ${checked ? "bg-purple-50" : ""}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={locked}
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
                                <div className="flex flex-wrap justify-end gap-1">
                                  {exclusion && (
                                    <span className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded-full">
                                      {EXCLUSION_LABELS[exclusion]}
                                    </span>
                                  )}
                                  {isAlreadyRecipient && (
                                    <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded-full">
                                      Ya añadida
                                    </span>
                                  )}
                                </div>
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
                onClick={closeRecipientsModal}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleUpdateRecipients}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
              >
                Guardar destinatarias
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
                  if (newCount > 0) changes.push(`+${newCount} nuevas`);
                  if (removedCount > 0)
                    changes.push(`-${removedCount} quitadas`);

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
                  Campaña de reactivación
                </h2>
                <p className="text-sm text-gray-500">
                  Escribe sola a las clientas que vinieron alguna vez y llevan
                  tiempo sin volver
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
                    Clientas que vinieron alguna vez y no han vuelto en{" "}
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
                          linkedPromotionId: e.target.value,
                        })
                      }
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                    >
                      <option value="">Sin promoción</option>
                      {promotions.map((promo: Promotion) => (
                        <option key={promo.id} value={promo.id}>
                          {promo.name} ({promo.code}) -{" "}
                          {discountLabel(promo.type, promo.value)}
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
                    "Puedes usar {{clientName}}, {{salonName}}, {{discountCode}} y {{discountValue}}. Si la promoción deja de valer, el código y el descuento se quitan del email."
                  }
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t("email_campaigns.preview_text")}
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
                <p className="mt-1 text-xs text-gray-500">{t("email_campaigns.unsubscribe_note")}</p>
              </div>

              <div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {t("email_campaigns.reply_to")}
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
                    placeholder={tenant.data?.email || "info@tupeluqueria.com"}
                    className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    {t("email_campaigns.reply_to_hint")}{" "}
                    {t("email_campaigns.sender_note")}
                  </p>
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
                  {t("email_campaigns.create_campaign")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingAction}
        title={
          pendingAction
            ? t(`email_campaigns.confirm.${pendingAction.action}.title`, {
                name: pendingAction.campaign.name,
              })
            : ""
        }
        description={
          pendingAction
            ? confirmDescription(pendingAction.action, pendingAction.campaign)
            : undefined
        }
        confirmLabel={pendingAction ? t(`email_campaigns.confirm.${pendingAction.action}.cta`) : undefined}
        destructive={pendingAction?.action === "delete"}
        loading={performingAction}
        onCancel={() => setPendingAction(null)}
        onConfirm={performPendingAction}
      />
    </div>
  );
}
