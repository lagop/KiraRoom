import { Injectable, NotFoundException, BadRequestException, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import {
  BOOKING_EMAIL_REFUSAL_TEXT,
  BOOKING_WHATSAPP_NOTICES_TEXT,
  BOOKING_WHATSAPP_PROMOTIONS_VERSION,
  bookingWhatsAppPromotionsText,
  ChoiceKind,
  ChoiceSource,
  MARKETING_FIELD_ID,
  SYSTEM_CONSENT_PURPOSES,
  marketingFormFor,
  purposeOf,
  MarketingConsentState,
  marketingStateOf,
  sameWording,
} from "./marketing-consent";
import {
  NoticeChannels,
  noticeChannelsOf,
  salonOffersWhatsAppPromotions,
  salonWhatsAppConnected,
  smsConfigured,
  withNoticeChannels,
} from "./client-notices";
import { samePhone } from "../common/phone";

/** A client's appointment notices, for the client file. */
export interface ClientNoticesState {
  /** The channels her appointment notices go by. */
  channels: NoticeChannels;
  /** Her request for WhatsApp notices: when and where it was made. */
  whatsappRequest: MarketingConsentState;
  /** Can the salon send them by each channel today? */
  available: { email: boolean; sms: boolean; whatsapp: boolean };
  /** Has she the contact details for it? */
  contact: { email: boolean; phone: boolean };
}

import {
  ConsentFormFieldDto as ConsentFormField,
  CreateConsentFormDto as CreateConsentFormInput,
  UpdateConsentFormDto as UpdateConsentFormInput,
} from "./consent.dto";

export type { ConsentFormField, CreateConsentFormInput, UpdateConsentFormInput };

/** A signature's answers go into a JSON column; a few KB is plenty. */
const MAX_RESPONSES_BYTES = 20_000;

@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    private prisma: PrismaService,
    private encryption: EncryptionService,
    // The plan check for the WhatsApp promotions box (global FeatureFlagModule).
    @Optional() private featureFlags?: FeatureFlagService,
  ) {}

  async listForms(tenantId: string) {
    return this.prisma.consentForm.findMany({
      // The marketing form is the system's, not one of the salon's forms.
      where: { tenantId, purpose: { notIn: SYSTEM_CONSENT_PURPOSES } },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    });
  }

  async createForm(tenantId: string, input: CreateConsentFormInput) {
    if (!input.name) throw new BadRequestException("name required");
    if (!Array.isArray(input.fields) || input.fields.length === 0) {
      throw new BadRequestException("fields must be a non-empty array");
    }
    return this.prisma.consentForm.create({
      data: {
        tenantId,
        name: input.name,
        description: input.description ?? null,
        fields: input.fields as any,
        serviceIds: input.serviceIds ?? [],
        version: 1,
      },
    });
  }

  /**
   * Immutable versioning: every PATCH creates a new ConsentForm with version+1,
   * marks the previous one inactive. Existing Consents retain their snapshot
   * via Consent.formSnapshot + formVersion.
   */
  async updateForm(
    tenantId: string,
    id: string,
    input: UpdateConsentFormInput,
  ): Promise<any> {
    const existing = await this.prisma.consentForm.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw new NotFoundException("Consent form not found");
    if (SYSTEM_CONSENT_PURPOSES.includes(existing.purpose)) {
      throw new BadRequestException("The marketing consent form is managed by the system");
    }
    if (!existing.isActive) {
      throw new BadRequestException(
        "Cannot edit a previous version — create a new form instead",
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.consentForm.update({
        where: { id: existing.id },
        data: { isActive: false },
      });
      const newVersion = await tx.consentForm.create({
        data: {
          tenantId,
          name: input.name ?? existing.name,
          description: input.description ?? existing.description,
          fields: (input.fields ?? (existing.fields as any)) as any,
          serviceIds: input.serviceIds ?? existing.serviceIds,
          version: existing.version + 1,
          isActive: true,
        },
      });
      return newVersion;
    });
  }

  async deleteForm(tenantId: string, id: string) {
    const existing = await this.prisma.consentForm.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw new NotFoundException("Consent form not found");
    if (SYSTEM_CONSENT_PURPOSES.includes(existing.purpose)) {
      throw new BadRequestException("The marketing consent form is managed by the system");
    }
    await this.prisma.consentForm.delete({ where: { id } });
    return { deleted: true };
  }

  async getRequiredForms(tenantId: string, serviceId?: string) {
    const forms = await this.prisma.consentForm.findMany({
      where: {
        tenantId,
        isActive: true,
        // Never the marketing form: saying no to promotions must not
        // block a booking.
        purpose: { notIn: SYSTEM_CONSENT_PURPOSES },
        ...(serviceId ? { serviceIds: { has: serviceId } } : {}),
      },
    });
    return forms.filter((f) => !serviceId || f.serviceIds.length === 0 || f.serviceIds.includes(serviceId));
  }

  /**
   * Records a signed consent for one of the salon's clients. `tenantId`
   * comes from the session (see ConsentController.sign). `recordedBy` is
   * set when a team member records a signature taken in the salon (their
   * user id): it is kept in the record's responses, like the marketing
   * choices the salon records. Without it, the client signs for herself
   * and her name is the default signature.
   */
  async sign(input: {
    tenantId: string;
    clientId: string;
    formId: string;
    responses: Record<string, unknown>;
    signatureName?: string;
    ip?: string;
    appointmentId?: string;
    serviceId?: string;
    recordedBy?: string;
  }) {
    const form = await this.prisma.consentForm.findUnique({
      where: { id: input.formId },
    });
    if (!form || form.tenantId !== input.tenantId) {
      throw new NotFoundException("Consent form not found");
    }
    if (!form.isActive) {
      throw new BadRequestException("Form version is no longer active");
    }
    if (SYSTEM_CONSENT_PURPOSES.includes(form.purpose)) {
      // The marketing choice has its own routes (recordMarketingChoice),
      // which revoke the previous choice.
      throw new BadRequestException("Communication choices are recorded through their own routes");
    }
    if (input.recordedBy && (!input.signatureName || input.signatureName.trim().length < 2)) {
      throw new BadRequestException("Typed signature name required");
    }
    if (JSON.stringify(input.responses ?? {}).length > MAX_RESPONSES_BYTES) {
      throw new BadRequestException("Responses too large");
    }
    const client = await this.prisma.client.findFirst({
      where: { id: input.clientId, tenantId: input.tenantId },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!client) throw new NotFoundException("Client not found");
    if (input.appointmentId) {
      // The appointment must be this client's, in this salon; a service
      // named with it must be one of the appointment's.
      const appointment = await this.prisma.appointment.findFirst({
        where: { id: input.appointmentId, tenantId: input.tenantId, clientId: input.clientId },
        select: { serviceId: true, services: { select: { serviceId: true } } },
      });
      if (!appointment) throw new NotFoundException("Appointment not found");
      if (
        input.serviceId &&
        input.serviceId !== appointment.serviceId &&
        !appointment.services.some((s) => s.serviceId === input.serviceId)
      ) {
        throw new BadRequestException("The service is not part of this appointment");
      }
    } else if (input.serviceId) {
      const service = await this.prisma.service.findFirst({
        where: { id: input.serviceId, tenantId: input.tenantId },
        select: { id: true },
      });
      if (!service) throw new NotFoundException("Service not found");
    }
    const signatureName =
      input.signatureName?.trim() || `${client.firstName ?? ""} ${client.lastName ?? ""}`.trim();
    if (signatureName.length < 2) throw new BadRequestException("Typed signature name required");
    // Who recorded it is the session's to say, never the answers'.
    const { source: _source, recordedBy: _recordedBy, ...answers } = input.responses ?? {};
    const responses = input.recordedBy ? { ...answers, source: "salon", recordedBy: input.recordedBy } : answers;
    return this.prisma.consent.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        formId: form.id,
        formVersion: form.version,
        formSnapshot: form.fields as any,
        responses: responses as any,
        signatureName,
        signatureIpHash: this.encryption.hashIp(input.ip ?? ""),
        appointmentId: input.appointmentId ?? null,
        serviceId: input.serviceId ?? null,
      },
    });
  }

  async hasValidConsent(
    tenantId: string,
    clientId: string,
    serviceId?: string,
  ): Promise<boolean> {
    const required = await this.getRequiredForms(tenantId, serviceId);
    if (required.length === 0) return true;
    for (const form of required) {
      const ok = await this.prisma.consent.findFirst({
        where: {
          tenantId,
          clientId,
          formId: form.id,
          revokedAt: null,
        },
        orderBy: { signedAt: "desc" },
      });
      if (!ok) return false;
    }
    return true;
  }

  async revoke(tenantId: string, consentId: string, reason?: string) {
    const c = await this.prisma.consent.findFirst({
      where: { id: consentId, tenantId },
    });
    if (!c) throw new NotFoundException("Consent not found");
    return this.prisma.consent.update({
      where: { id: consentId },
      data: { revokedAt: new Date(), revokeReason: reason ?? null },
    });
  }

  // ────────── Commercial communications (see marketing-consent.ts) ──────────

  /**
   * The salon's system form for this choice, created on first use. When its
   * wording has changed since (marketing-consent.ts), the stored form is
   * retired and a new version with the current wording is made: a new
   * record always keeps the text it was given for, and the old ones keep
   * theirs in their snapshot.
   */
  async ensureMarketingForm(tenantId: string, channel: ChoiceKind = "email") {
    const purpose = purposeOf(channel);
    const { name, fields } = marketingFormFor(channel);
    const existing = await this.prisma.consentForm.findFirst({
      where: { tenantId, purpose, isActive: true },
      orderBy: { version: "desc" },
    });
    if (existing && sameWording(existing.fields, fields)) return existing;
    if (existing) {
      const retired = await this.prisma.consentForm.updateMany({
        where: { id: existing.id, isActive: true },
        data: { isActive: false },
      });
      if (retired.count === 0) {
        // Another request retired it meanwhile: use the version it made.
        const current = await this.prisma.consentForm.findFirst({
          where: { tenantId, purpose, isActive: true },
          orderBy: { version: "desc" },
        });
        if (current && sameWording(current.fields, fields)) return current;
      }
    }
    return this.prisma.consentForm.create({
      data: {
        tenantId,
        name,
        description:
          channel === "whatsapp_notices"
            ? "Petición de cada cliente de recibir los avisos de sus citas por WhatsApp. La gestiona el sistema."
            : "Elección de cada cliente sobre las comunicaciones comerciales. La gestiona el sistema.",
        fields: fields as any,
        serviceIds: [],
        purpose,
        version: (existing?.version ?? 0) + 1,
      },
    });
  }

  /** The client's current choice, with the wording it was given for. */
  async getMarketingConsent(
    tenantId: string,
    clientId: string,
    channel: ChoiceKind = "email",
  ): Promise<MarketingConsentState> {
    const current = await this.prisma.consent.findFirst({
      where: { tenantId, clientId, revokedAt: null, form: { purpose: purposeOf(channel) } },
      orderBy: { signedAt: "desc" },
      select: { responses: true, signedAt: true, formSnapshot: true },
    });
    return marketingStateOf(current, channel);
  }

  /**
   * Records the client's choice. The previous record is revoked (kept, with
   * the reason) and a new one is signed with the client's name, the wording
   * shown and the hashed IP. Repeating the current choice records nothing.
   *
   * `recordedBy` is set when the salon records a choice the client made in
   * person (a staff user id): it is kept in the record's responses, so the
   * record says it was not the client who clicked.
   *
   * `source` says where it was made ("booking", "widget"; "salon" is implied
   * by recordedBy), `shown` the exact text next to the box she ticked (and
   * `shownVersion` the version of that text), and `appointmentId` the
   * booking it came with.
   */
  async recordMarketingChoice(input: {
    tenantId: string;
    clientId: string;
    accepts: boolean;
    ip?: string;
    channel?: ChoiceKind;
    recordedBy?: string;
    source?: ChoiceSource;
    shown?: string;
    shownVersion?: string;
    appointmentId?: string;
  }): Promise<MarketingConsentState> {
    const channel = input.channel ?? "email";
    const purpose = purposeOf(channel);
    const client = await this.prisma.client.findFirst({
      where: { id: input.clientId, tenantId: input.tenantId },
      select: { firstName: true, lastName: true },
    });
    if (!client) throw new NotFoundException("Client not found");

    const current = await this.getMarketingConsent(input.tenantId, input.clientId, channel);
    if (current.status === (input.accepts ? "granted" : "refused")) return current;

    const form = await this.ensureMarketingForm(input.tenantId, channel);
    const now = new Date();
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.consent.updateMany({
        where: {
          tenantId: input.tenantId,
          clientId: input.clientId,
          revokedAt: null,
          form: { purpose },
        },
        data: {
          revokedAt: now,
          revokeReason: input.recordedBy
            ? input.accepts
              ? "superseded_by_salon"
              : "withdrawn_by_salon"
            : input.accepts
              ? "superseded_by_client"
              : "withdrawn_by_client",
        },
      });
      return tx.consent.create({
        data: {
          tenantId: input.tenantId,
          clientId: input.clientId,
          formId: form.id,
          formVersion: form.version,
          formSnapshot: form.fields as any,
          responses: {
            [MARKETING_FIELD_ID]: input.accepts,
            ...(input.recordedBy
              ? { source: "salon", recordedBy: input.recordedBy }
              : input.source
                ? { source: input.source }
                : {}),
            ...(input.shown ? { shown: input.shown } : {}),
            ...(input.shown && input.shownVersion ? { shownVersion: input.shownVersion } : {}),
          } as any,
          signatureName:
            `${client.firstName ?? ""} ${client.lastName ?? ""}`.trim() || "Cliente",
          signatureIpHash: this.encryption.hashIp(input.ip ?? ""),
          signedAt: now,
          appointmentId: input.appointmentId ?? null,
        },
        select: { responses: true, signedAt: true, formSnapshot: true },
      });
    });
    this.logger.log(
      `${channel} choice ${input.accepts ? "granted" : "refused"} tenant=${input.tenantId} client=${input.clientId}` +
        (input.recordedBy ? ` (recorded by ${input.recordedBy})` : input.source ? ` (${input.source})` : ""),
    );
    return marketingStateOf(created, channel);
  }

  /**
   * The client file's rule (ClientsController): owner and admin reach every
   * client of the salon, staff only those with an appointment with them.
   * Anyone else answers 404, as the client file does.
   */
  async assertClientInReach(
    tenantId: string,
    clientId: string,
    user: { id: string; role: string },
  ): Promise<void> {
    const where =
      user.role === "staff"
        ? { id: clientId, tenantId, appointments: { some: { professional: { userId: user.id } } } }
        : { id: clientId, tenantId };
    const found = await this.prisma.client.findFirst({ where, select: { id: true } });
    if (!found) throw new NotFoundException("Cliente no encontrado");
  }

  // ────────── Appointment notices (see client-notices.ts) ──────────

  /** Has the salon its own WhatsApp number connected (the UTILITY templates' sender)? */
  whatsappConnected(tenantId: string): Promise<boolean> {
    return salonWhatsAppConnected(this.prisma, tenantId);
  }

  /** The client's appointment notices by channel, and her WhatsApp request. */
  async getClientNotices(tenantId: string, clientId: string): Promise<ClientNoticesState> {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
      select: { email: true, phone: true },
    });
    if (!client) throw new NotFoundException("Cliente no encontrado");
    const [prefs, whatsappRequest, whatsapp] = await Promise.all([
      this.prisma.notificationPreference.findUnique({ where: { clientId }, select: { preferences: true } }),
      this.getMarketingConsent(tenantId, clientId, "whatsapp_notices"),
      this.whatsappConnected(tenantId),
    ]);
    return {
      channels: noticeChannelsOf(prefs?.preferences),
      whatsappRequest,
      available: { email: true, sms: smsConfigured(), whatsapp },
      contact: { email: !!client.email?.trim(), phone: !!client.phone?.trim() },
    };
  }

  /**
   * Turns channels of the client's appointment notices on or off.
   *
   * WhatsApp on needs the salon's number connected and a phone, and is the
   * client's request: it is recorded (when, where, who wrote it down) like a
   * consent, and from the panel only after the team member confirms she
   * asked for it (`clientAsked`). WhatsApp off withdraws that record.
   */
  async setClientNotices(input: {
    tenantId: string;
    clientId: string;
    changes: Partial<NoticeChannels>;
    ip?: string;
    recordedBy?: string;
    clientAsked?: boolean;
    source?: ChoiceSource;
    shown?: string;
    appointmentId?: string;
  }): Promise<ClientNoticesState> {
    const { tenantId, clientId, changes } = input;
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
      select: { phone: true },
    });
    if (!client) throw new NotFoundException("Cliente no encontrado");

    if (changes.whatsapp === true) {
      if (input.recordedBy && input.clientAsked !== true) {
        throw new BadRequestException("Confirma que la clienta ha pedido recibir los avisos de sus citas por WhatsApp");
      }
      if (!client.phone?.trim()) {
        throw new BadRequestException("La clienta no tiene teléfono: añádelo a su ficha antes");
      }
      if (!(await this.whatsappConnected(tenantId))) {
        throw new BadRequestException("Conecta el WhatsApp del salón en Ajustes para enviar avisos por WhatsApp");
      }
    }

    if (typeof changes.whatsapp === "boolean") {
      const current = await this.getMarketingConsent(tenantId, clientId, "whatsapp_notices");
      // Off with no request on file: nothing to withdraw.
      if (changes.whatsapp || current.status === "granted") {
        await this.recordMarketingChoice({
          tenantId,
          clientId,
          accepts: changes.whatsapp,
          ip: input.ip,
          channel: "whatsapp_notices",
          recordedBy: input.recordedBy,
          source: input.source,
          shown: input.shown,
          appointmentId: input.appointmentId,
        });
      }
    }

    const stored = await this.prisma.notificationPreference.findUnique({
      where: { clientId },
      select: { preferences: true },
    });
    const preferences = withNoticeChannels(stored?.preferences, changes) as any;
    await this.prisma.notificationPreference.upsert({
      where: { clientId },
      create: { clientId, tenantId, preferences },
      update: { preferences },
    });
    if (input.recordedBy) {
      this.logger.log(
        `Appointment notice channels ${JSON.stringify(changes)} tenant=${tenantId} client=${clientId} (set by ${input.recordedBy})`,
      );
    }
    return this.getClientNotices(tenantId, clientId);
  }

  /**
   * What the client ticked when booking online (the salon's page or the
   * widget), recorded once the booking found or created her:
   *
   * - "No quiero recibir promociones ... por email": a refusal of email
   *   promotions, with the text she saw. Unticked records nothing (the
   *   existing-customer exception of LSSI art. 21.2 applies).
   * - "Recibir los avisos de mi cita por WhatsApp": her appointment notices
   *   go by WhatsApp too, from this booking's confirmation on. Only when the
   *   salon has WhatsApp connected (the box is shown only then), and only to
   *   the phone she typed: an existing client found by her email whose file
   *   has another number is left as she is.
   * - "Quiero recibir promociones de <salón> por WhatsApp": her opt-in to
   *   WhatsApp promotions, with the text she saw (the salon's name in it)
   *   and its version. Only when the salon offers the box (WhatsApp
   *   connected and a plan with WhatsApp campaigns), and only for the phone
   *   she typed. Unticked records nothing: it is not a refusal.
   *
   * Never fails the booking: a failure is logged.
   */
  async recordBookingChoices(input: {
    tenantId: string;
    clientId: string;
    appointmentId?: string;
    source: "booking" | "widget";
    ip?: string;
    typedPhone?: string;
    refusesMarketingEmail?: boolean;
    wantsWhatsAppNotices?: boolean;
    wantsWhatsAppPromotions?: boolean;
  }): Promise<void> {
    const { tenantId, clientId, source } = input;
    if (input.refusesMarketingEmail === true) {
      try {
        await this.recordMarketingChoice({
          tenantId,
          clientId,
          accepts: false,
          ip: input.ip,
          channel: "email",
          source,
          shown: BOOKING_EMAIL_REFUSAL_TEXT,
          appointmentId: input.appointmentId,
        });
      } catch (err) {
        this.logger.warn(`Booking email refusal of client ${clientId} not recorded: ${(err as Error).message}`);
      }
    }
    if (input.wantsWhatsAppNotices === true) {
      try {
        await this.turnOnBookingWhatsAppNotices(input);
      } catch (err) {
        this.logger.warn(`WhatsApp notices of client ${clientId} not turned on: ${(err as Error).message}`);
      }
    }
    if (input.wantsWhatsAppPromotions === true) {
      try {
        await this.recordBookingWhatsAppPromotions(input);
      } catch (err) {
        this.logger.warn(`WhatsApp promotions opt-in of client ${clientId} not recorded: ${(err as Error).message}`);
      }
    }
  }

  /** Is the number on her file the one she typed? Both WhatsApp boxes apply to that number only. */
  private async typedPhoneOnFile(tenantId: string, clientId: string, typedPhone?: string): Promise<boolean> {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
      select: { phone: true },
    });
    return samePhone(client?.phone, typedPhone);
  }

  private async turnOnBookingWhatsAppNotices(input: {
    tenantId: string;
    clientId: string;
    appointmentId?: string;
    source: "booking" | "widget";
    ip?: string;
    typedPhone?: string;
  }): Promise<void> {
    const { tenantId, clientId } = input;
    if (!(await this.typedPhoneOnFile(tenantId, clientId, input.typedPhone))) {
      this.logger.log(`WhatsApp notices not turned on for client ${clientId}: the phone on file is not the one typed`);
      return;
    }
    if (!(await this.whatsappConnected(tenantId))) {
      this.logger.log(`WhatsApp notices not turned on for client ${clientId}: the salon has no WhatsApp connected`);
      return;
    }
    await this.setClientNotices({
      tenantId,
      clientId,
      changes: { whatsapp: true },
      ip: input.ip,
      source: input.source,
      shown: BOOKING_WHATSAPP_NOTICES_TEXT,
      appointmentId: input.appointmentId,
    });
  }

  private async recordBookingWhatsAppPromotions(input: {
    tenantId: string;
    clientId: string;
    appointmentId?: string;
    source: "booking" | "widget";
    ip?: string;
    typedPhone?: string;
  }): Promise<void> {
    const { tenantId, clientId } = input;
    if (!(await this.typedPhoneOnFile(tenantId, clientId, input.typedPhone))) {
      this.logger.log(`WhatsApp promotions not recorded for client ${clientId}: the phone on file is not the one typed`);
      return;
    }
    // The box is offered only then; a request that ticks it anyway records nothing.
    if (!(await salonOffersWhatsAppPromotions(this.prisma, this.featureFlags, tenantId))) {
      this.logger.log(
        `WhatsApp promotions not recorded for client ${clientId}: the salon has no WhatsApp connected or its plan has no WhatsApp campaigns`,
      );
      return;
    }
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    await this.recordMarketingChoice({
      tenantId,
      clientId,
      accepts: true,
      ip: input.ip,
      channel: "whatsapp",
      source: input.source,
      shown: bookingWhatsAppPromotionsText(tenant?.name ?? ""),
      shownVersion: BOOKING_WHATSAPP_PROMOTIONS_VERSION,
      appointmentId: input.appointmentId,
    });
  }
}
