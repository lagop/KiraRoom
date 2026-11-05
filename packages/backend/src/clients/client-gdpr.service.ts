import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { AppointmentStatus, UserRole } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { AuditLogService } from "../saas/audit-log.service";
import {
  MARKETING_FIELD_ID,
  MARKETING_PURPOSE,
  SYSTEM_CONSENT_PURPOSES,
  WHATSAPP_MARKETING_PURPOSE,
  WHATSAPP_NOTICES_PURPOSE,
  marketingStateOf,
} from "../consent/marketing-consent";
import { CLIENT_DETAIL_SELECT } from "./client-select";
import { anonymizeClients, whatsappVisitorKeys } from "./client-anonymize";

export interface GdprActor {
  id: string;
  role: UserRole;
}

const name = (p: { firstName: string; lastName: string } | null | undefined) =>
  p ? `${p.firstName} ${p.lastName}`.trim() : null;

/** "1234" of "GIFT-ABCD-1234": enough for her to recognise it, not to spend it. */
const maskCode = (code: string) => (code.length > 4 ? `…${code.slice(-4)}` : "…");

/**
 * A client's rights over her data at the salon: a copy of it (RGPD arts. 15
 * and 20) and erasure (art. 17). Owner / admin only (see the controller).
 */
@Injectable()
export class ClientGdprService {
  private readonly logger = new Logger(ClientGdprService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Everything the salon holds about her, as a JSON document she can read
   * and take elsewhere. Never her sign-in secrets, other clients' data, or
   * staff data beyond the professional's name.
   */
  async export(tenantId: string, clientId: string, actor: GdprActor) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
      select: { ...CLIENT_DETAIL_SELECT, passwordHash: true },
    });
    if (!client) throw new NotFoundException("Cliente no encontrado");
    const { passwordHash, ...profile } = client;
    const byClient = { tenantId, clientId };

    const [
      tenant,
      appointments,
      consents,
      invoices,
      payments,
      orders,
      loyalty,
      wallet,
      giftCards,
      reviews,
      waitList,
      cadence,
      rebookingReminders,
      conversations,
      notifications,
      emailCampaigns,
      whatsappCampaigns,
      promotionUsage,
      receptionistProfile,
      notificationPreference,
      tillSales,
    ] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, legalName: true, taxId: true } }),
      this.prisma.appointment.findMany({
        where: byClient,
        orderBy: { scheduledDate: "desc" },
        select: {
          id: true,
          createdAt: true,
          scheduledDate: true,
          scheduledTime: true,
          endTime: true,
          duration: true,
          status: true,
          source: true,
          location: true,
          address: true,
          price: true,
          currency: true,
          discount: true,
          addons: true,
          totalAmount: true,
          amountPaid: true,
          amountDue: true,
          paymentStatus: true,
          paymentMethod: true,
          depositRequired: true,
          depositAmount: true,
          depositPaid: true,
          notes: true,
          internalNotes: true,
          cancellationReason: true,
          checkInTime: true,
          completionTime: true,
          rating: true,
          review: true,
          service: { select: { name: true } },
          professional: { select: { firstName: true, lastName: true } },
          salonLocation: { select: { name: true } },
          services: {
            orderBy: { order: "asc" },
            select: {
              service: { select: { name: true } },
              professional: { select: { firstName: true, lastName: true } },
            },
          },
        },
      }),
      this.prisma.consent.findMany({
        where: byClient,
        orderBy: { signedAt: "asc" },
        select: {
          id: true,
          signedAt: true,
          revokedAt: true,
          revokeReason: true,
          expiresAt: true,
          formVersion: true,
          formSnapshot: true,
          responses: true,
          signatureName: true,
          signatureIpHash: true,
          appointmentId: true,
          form: { select: { name: true, purpose: true } },
        },
      }),
      // Only invoices made out to her: their recipient is her own data.
      this.prisma.invoice.findMany({
        where: { tenantId, recipientType: "client", recipientId: clientId },
        orderBy: { issueDate: "asc" },
        select: {
          series: true,
          number: true,
          issueDate: true,
          status: true,
          recipientName: true,
          recipientTaxId: true,
          recipientAddress: true,
          subtotalCents: true,
          taxBreakdown: true,
          totalCents: true,
          currency: true,
          notes: true,
          lines: {
            select: {
              description: true,
              quantity: true,
              unitPriceCents: true,
              discountPct: true,
              taxRate: true,
              taxCents: true,
              totalCents: true,
            },
          },
        },
      }),
      this.prisma.payment.findMany({
        where: byClient,
        orderBy: { createdAt: "asc" },
        select: {
          createdAt: true,
          amount: true,
          currency: true,
          type: true,
          status: true,
          method: true,
          isDeposit: true,
          description: true,
          appointmentId: true,
          refunds: { select: { createdAt: true, amount: true, status: true, reason: true } },
        },
      }),
      this.prisma.order.findMany({
        where: byClient,
        orderBy: { createdAt: "asc" },
        select: {
          orderNumber: true,
          createdAt: true,
          status: true,
          type: true,
          subtotal: true,
          taxAmount: true,
          discount: true,
          total: true,
          paidAmount: true,
          paymentMethod: true,
          pointsEarned: true,
          pointsRedeemed: true,
          notes: true,
          items: { select: { quantity: true, unitPrice: true, totalPrice: true, product: { select: { name: true } } } },
        },
      }),
      this.prisma.loyaltyMember.findMany({
        where: { clientId, client: { tenantId } },
        select: {
          joinedAt: true,
          status: true,
          lifetimePoints: true,
          currentPoints: true,
          totalEarned: true,
          totalRedeemed: true,
          totalSpent: true,
          lastActivityAt: true,
          program: { select: { name: true } },
          tier: { select: { name: true } },
          transactions: {
            orderBy: { createdAt: "asc" },
            select: { createdAt: true, type: true, points: true, source: true, description: true },
          },
          redemptions: {
            orderBy: { createdAt: "asc" },
            select: { createdAt: true, pointsSpent: true, valueReceived: true, status: true, usedAt: true, reward: { select: { name: true } } },
          },
        },
      }),
      this.prisma.clientWallet.findFirst({
        where: byClient,
        select: {
          balance: true,
          loyaltyPoints: true,
          totalEarned: true,
          totalSpent: true,
          transactions: {
            orderBy: { createdAt: "asc" },
            select: { createdAt: true, type: true, amount: true, points: true, description: true, balanceAfter: true },
          },
        },
      }),
      this.prisma.giftCard.findMany({
        where: {
          tenantId,
          OR: [
            { recipientId: clientId },
            { purchasedById: clientId },
            ...(profile.email ? [{ recipientEmail: { equals: profile.email, mode: "insensitive" as const } }] : []),
          ],
        },
        select: {
          createdAt: true,
          code: true,
          initialAmount: true,
          currentBalance: true,
          isActive: true,
          expiresAt: true,
          purchasedById: true,
          recipientId: true,
          recipientEmail: true,
          recipientName: true,
          message: true,
        },
      }),
      this.prisma.review.findMany({
        where: { ...byClient, status: { not: "pending" } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, submittedAt: true, rating: true, comment: true, status: true, source: true, appointmentId: true, professionalId: true },
      }),
      this.prisma.waitList.findMany({
        where: byClient,
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, serviceId: true, professionalId: true, earliestDate: true, latestDate: true, status: true, notes: true, notifiedAt: true, notifyCount: true },
      }),
      this.prisma.clientCadence.findFirst({
        where: byClient,
        select: { byService: true, nextRecommendedReminderAt: true, recommendedServiceId: true, optedOut: true, lastComputedAt: true },
      }),
      this.prisma.rebookingReminder.findMany({
        where: byClient,
        orderBy: { scheduledAt: "asc" },
        select: { scheduledAt: true, sentAt: true, channel: true, status: true, serviceId: true },
      }),
      this.prisma.chatConversation.findMany({
        where: {
          tenantId,
          OR: [
            { clientId },
            ...whatsappVisitorKeys(profile.phone).map((key) => ({
              clientId: null,
              context: { path: ["visitorKey"], equals: key },
            })),
          ],
        },
        orderBy: { createdAt: "asc" },
        select: {
          createdAt: true,
          channel: true,
          status: true,
          messages: { orderBy: { createdAt: "asc" }, select: { createdAt: true, role: true, content: true } },
        },
      }),
      this.prisma.notification.findMany({
        where: byClient,
        orderBy: { createdAt: "asc" },
        select: {
          createdAt: true,
          type: true,
          title: true,
          message: true,
          isRead: true,
          readAt: true,
          deliveries: { select: { channel: true, status: true, sentAt: true, deliveredAt: true } },
        },
      }),
      this.prisma.emailCampaignRecipient.findMany({
        where: { clientId, campaign: { tenantId } },
        orderBy: { createdAt: "asc" },
        select: {
          status: true,
          sentAt: true,
          deliveredAt: true,
          openedAt: true,
          clickedAt: true,
          unsubscribedAt: true,
          campaign: { select: { name: true, subject: true } },
        },
      }),
      this.prisma.whatsAppCampaignRecipient.findMany({
        where: { clientId, campaign: { tenantId } },
        orderBy: { createdAt: "asc" },
        select: { status: true, sentAt: true, deliveredAt: true, readAt: true, campaign: { select: { name: true } } },
      }),
      this.prisma.promotionUsage.findMany({
        where: { clientId },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, promotionId: true, discountAmount: true, appointmentId: true },
      }),
      // What the virtual receptionist remembers about her.
      this.prisma.clientProfile.findFirst({
        where: byClient,
        select: {
          createdAt: true,
          updatedAt: true,
          name: true,
          email: true,
          phone: true,
          preferences: true,
          interactionHistory: true,
          bookingHistory: true,
          servicePreferences: true,
          communicationPreferences: true,
        },
      }),
      this.prisma.notificationPreference.findFirst({
        where: byClient,
        select: { preferences: true, updatedAt: true },
      }),
      // Her tickets at the till (the payments above are their money).
      this.prisma.posSale.findMany({
        where: byClient,
        orderBy: { createdAt: "asc" },
        select: {
          createdAt: true,
          kind: true,
          subtotalCents: true,
          discountCents: true,
          loyaltyDiscountCents: true,
          totalCents: true,
          invoiceId: true,
          lines: {
            orderBy: { lineIndex: "asc" },
            select: { kind: true, description: true, quantity: true, unitPriceCents: true, discountCents: true, totalCents: true },
          },
        },
      }),
    ]);

    // Names for the ids above, from this salon only.
    const serviceIds = [...waitList.map((w) => w.serviceId), ...rebookingReminders.map((r) => r.serviceId)];
    if (cadence?.recommendedServiceId) serviceIds.push(cadence.recommendedServiceId);
    const professionalIds = [...waitList.map((w) => w.professionalId), ...reviews.map((r) => r.professionalId)];
    const [services, professionals, promotions] = await Promise.all([
      this.prisma.service.findMany({
        where: { tenantId, id: { in: serviceIds.filter((x): x is string => !!x) } },
        select: { id: true, name: true },
      }),
      this.prisma.professional.findMany({
        where: { tenantId, id: { in: professionalIds.filter((x): x is string => !!x) } },
        select: { id: true, firstName: true, lastName: true },
      }),
      this.prisma.promotion.findMany({
        where: { tenantId, id: { in: promotionUsage.map((p) => p.promotionId) } },
        select: { id: true, name: true },
      }),
    ]);
    const serviceName = new Map(services.map((s) => [s.id, s.name]));
    const professionalName = new Map(professionals.map((p) => [p.id, name(p)]));
    const promotionName = new Map(promotions.map((p) => [p.id, p.name]));
    const svc = (id: string | null | undefined) => (id ? serviceName.get(id) ?? null : null);
    const pro = (id: string | null | undefined) => (id ? professionalName.get(id) ?? null : null);

    const isMarketing = (purpose: string) => SYSTEM_CONSENT_PURPOSES.includes(purpose);
    const marketingRecords = consents.filter((c) => isMarketing(c.form.purpose));
    const activeMarketing = (purpose: string) =>
      marketingRecords.find((c) => c.form.purpose === purpose && !c.revokedAt) ?? null;
    const whatsappPurpose = WHATSAPP_MARKETING_PURPOSE;

    const document = {
      format: "kiraroom-client-export-v1",
      generatedAt: new Date().toISOString(),
      about:
        "Copia de los datos personales que el salón guarda sobre la clienta (RGPD, arts. 15 y 20). " +
        "Importes: los campos que terminan en Cents, los pagos (payments), las devoluciones y el monedero (wallet) van en céntimos; " +
        "los precios de citas y compras, en euros.",
      controller: tenant ? { name: tenant.legalName || tenant.name, taxId: tenant.taxId } : null,
      client: { ...profile, hasOnlineAccount: !!passwordHash },
      marketingConsent: {
        email: marketingStateOf(activeMarketing(MARKETING_PURPOSE)),
        whatsapp: marketingStateOf(activeMarketing(whatsappPurpose), "whatsapp"),
        // Not a promotion: her request for appointment notices by WhatsApp.
        whatsappAppointmentNotices: marketingStateOf(activeMarketing(WHATSAPP_NOTICES_PURPOSE), "whatsapp_notices"),
        history: marketingRecords.map((c) => {
          const responses = (c.responses ?? {}) as Record<string, unknown>;
          return {
            channel:
              c.form.purpose === whatsappPurpose
                ? "whatsapp"
                : c.form.purpose === WHATSAPP_NOTICES_PURPOSE
                  ? "whatsapp_appointment_notices"
                  : "email",
            accepts: responses[MARKETING_FIELD_ID] === true,
            recordedBy: responses.source === "salon" ? "salon" : "client",
            // Where she chose it (booking page, widget, salon) and the text she saw.
            source: typeof responses.source === "string" ? responses.source : null,
            shown: typeof responses.shown === "string" ? responses.shown : null,
            signedAt: c.signedAt,
            revokedAt: c.revokedAt,
            revokeReason: c.revokeReason,
          };
        }),
      },
      consents: consents
        .filter((c) => !isMarketing(c.form.purpose))
        .map((c) => ({
          form: c.form.name,
          formVersion: c.formVersion,
          signedAt: c.signedAt,
          signatureName: c.signatureName,
          signatureIpHash: c.signatureIpHash,
          revokedAt: c.revokedAt,
          revokeReason: c.revokeReason,
          expiresAt: c.expiresAt,
          appointmentId: c.appointmentId,
          questions: c.formSnapshot,
          answers: c.responses,
        })),
      appointments: appointments.map(({ service, professional, salonLocation, services: lines, ...a }) => ({
        ...a,
        service: service?.name ?? null,
        professional: name(professional),
        location: salonLocation?.name ?? a.location,
        services: lines.map((l) => ({ service: l.service?.name ?? null, professional: name(l.professional) })),
      })),
      invoices,
      payments,
      purchases: orders.map(({ items, ...o }) => ({
        ...o,
        items: items.map((i) => ({ product: i.product?.name ?? null, quantity: i.quantity, unitPrice: i.unitPrice, totalPrice: i.totalPrice })),
      })),
      loyalty: loyalty.map(({ program, tier, redemptions, ...m }) => ({
        ...m,
        program: program.name,
        tier: tier?.name ?? null,
        redemptions: redemptions.map(({ reward, ...r }) => ({ ...r, reward: reward.name })),
      })),
      wallet,
      giftCards: giftCards.map((g) => {
        // She bought it for someone else: the recipient is that person's data.
        const forHer =
          g.recipientId === clientId ||
          (!!profile.email && g.recipientEmail?.toLowerCase() === profile.email.toLowerCase());
        return {
          createdAt: g.createdAt,
          code: maskCode(g.code),
          role: forHer ? "recipient" : "purchaser",
          initialAmountCents: g.initialAmount,
          currentBalanceCents: g.currentBalance,
          isActive: g.isActive,
          expiresAt: g.expiresAt,
          ...(forHer ? { recipientName: g.recipientName, recipientEmail: g.recipientEmail, message: g.message } : {}),
        };
      }),
      reviews: reviews.map(({ professionalId, ...r }) => ({ ...r, professional: pro(professionalId) })),
      waitList: waitList.map(({ serviceId, professionalId, ...w }) => ({
        ...w,
        service: svc(serviceId),
        professional: pro(professionalId),
      })),
      rebooking: {
        cadence: cadence
          ? {
              byService: cadence.byService,
              nextRecommendedReminderAt: cadence.nextRecommendedReminderAt,
              recommendedService: svc(cadence.recommendedServiceId),
              optedOut: cadence.optedOut,
              lastComputedAt: cadence.lastComputedAt,
            }
          : null,
        reminders: rebookingReminders.map(({ serviceId, ...r }) => ({ ...r, service: svc(serviceId) })),
      },
      receptionistProfile,
      conversations,
      notificationPreferences: notificationPreference,
      tillSales,
      notifications,
      campaigns: {
        email: emailCampaigns.map(({ campaign, ...r }) => ({ ...r, campaign: campaign.name, subject: campaign.subject })),
        whatsapp: whatsappCampaigns.map(({ campaign, ...r }) => ({ ...r, campaign: campaign.name })),
      },
      promotionsUsed: promotionUsage.map(({ promotionId, ...p }) => ({ ...p, promotion: promotionName.get(promotionId) ?? null })),
    };

    await this.auditLog.record("client.gdpr_export", {
      actorId: actor.id,
      actorRole: actor.role,
      tenantId,
      metadata: { clientId },
    });
    return document;
  }

  /**
   * Erase her personal data (see anonymizeClients for what goes and what
   * stays). Refused while she has upcoming appointments: the salon cancels
   * them first, so nobody turns up for a booking the salon can no longer
   * place or confirm.
   */
  async anonymize(tenantId: string, clientId: string, actor: GdprActor) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
      select: { id: true },
    });
    if (!client) throw new NotFoundException("Cliente no encontrado");

    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const upcoming = await this.prisma.appointment.count({
      where: {
        tenantId,
        clientId,
        scheduledDate: { gte: startOfToday },
        status: { in: [AppointmentStatus.pending, AppointmentStatus.confirmed, AppointmentStatus.in_progress] },
      },
    });
    if (upcoming > 0) {
      throw new ConflictException(
        upcoming === 1
          ? "Tiene una cita pendiente. Cancélala antes de anonimizar sus datos."
          : `Tiene ${upcoming} citas pendientes. Cancélalas antes de anonimizar sus datos.`,
      );
    }

    await this.prisma.$transaction(
      async (tx) => {
        await anonymizeClients(tx, tenantId, [clientId]);
        // What happened, by whom; nothing about who she was.
        await this.auditLog.record(
          "client.gdpr_anonymize",
          { actorId: actor.id, actorRole: actor.role, tenantId, metadata: { clientId } },
          tx,
        );
      },
      { timeout: 30_000 },
    );
    this.logger.log(`Client ${clientId} of tenant ${tenantId} anonymised by ${actor.id}`);
    return { ok: true as const };
  }
}
