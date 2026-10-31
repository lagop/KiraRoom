import { Injectable, NotFoundException, BadRequestException, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import {
  MARKETING_FIELD_ID,
  MarketingChannel,
  SYSTEM_CONSENT_PURPOSES,
  marketingFormFor,
  purposeOf,
  MarketingConsentState,
  marketingStateOf,
} from "./marketing-consent";

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
      throw new BadRequestException("Marketing consent is given from the client's account");
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

  /** The salon's system form for the marketing choice, created on first use. */
  async ensureMarketingForm(tenantId: string, channel: MarketingChannel = "email") {
    const purpose = purposeOf(channel);
    const { name, fields } = marketingFormFor(channel);
    const existing = await this.prisma.consentForm.findFirst({
      where: { tenantId, purpose, isActive: true },
      orderBy: { version: "desc" },
    });
    if (existing) return existing;
    return this.prisma.consentForm.create({
      data: {
        tenantId,
        name,
        description:
          "Elección de cada cliente sobre las comunicaciones comerciales. La gestiona el sistema.",
        fields: fields as any,
        serviceIds: [],
        purpose,
        version: 1,
      },
    });
  }

  /** The client's current choice, with the wording it was given for. */
  async getMarketingConsent(
    tenantId: string,
    clientId: string,
    channel: MarketingChannel = "email",
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
   */
  async recordMarketingChoice(input: {
    tenantId: string;
    clientId: string;
    accepts: boolean;
    ip?: string;
    channel?: MarketingChannel;
    recordedBy?: string;
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
            ...(input.recordedBy ? { source: "salon", recordedBy: input.recordedBy } : {}),
          } as any,
          signatureName:
            `${client.firstName ?? ""} ${client.lastName ?? ""}`.trim() || "Cliente",
          signatureIpHash: this.encryption.hashIp(input.ip ?? ""),
          signedAt: now,
        },
        select: { responses: true, signedAt: true, formSnapshot: true },
      });
    });
    this.logger.log(
      `${channel} marketing consent ${input.accepts ? "granted" : "refused"} tenant=${input.tenantId} client=${input.clientId}` +
        (input.recordedBy ? ` (recorded by ${input.recordedBy})` : ""),
    );
    return marketingStateOf(created, channel);
  }
}
