import { Injectable, NotFoundException, BadRequestException, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";
import {
  MARKETING_FIELD_ID,
  MARKETING_FIELDS,
  MARKETING_FORM_NAME,
  MARKETING_PURPOSE,
  MarketingConsentState,
  marketingStateOf,
} from "./marketing-consent";

export interface ConsentFormField {
  id: string;
  type: "boolean" | "text" | "select" | "date" | "info";
  label: string;
  required?: boolean;
  options?: string[];
  helpText?: string;
}

export interface CreateConsentFormInput {
  name: string;
  description?: string;
  fields: ConsentFormField[];
  serviceIds?: string[];
}

export interface UpdateConsentFormInput {
  name?: string;
  description?: string;
  fields?: ConsentFormField[];
  serviceIds?: string[];
}

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
      where: { tenantId, purpose: { not: MARKETING_PURPOSE } },
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
    if (existing.purpose === MARKETING_PURPOSE) {
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
    if (existing.purpose === MARKETING_PURPOSE) {
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
        purpose: { not: MARKETING_PURPOSE },
        ...(serviceId ? { serviceIds: { has: serviceId } } : {}),
      },
    });
    return forms.filter((f) => !serviceId || f.serviceIds.length === 0 || f.serviceIds.includes(serviceId));
  }

  async sign(input: {
    tenantId: string;
    clientId: string;
    formId: string;
    responses: Record<string, unknown>;
    signatureName: string;
    ip?: string;
    appointmentId?: string;
    serviceId?: string;
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
    if (form.purpose === MARKETING_PURPOSE) {
      // This route is public and takes the client id from the body; the
      // marketing choice is only recorded by the signed-in client.
      throw new BadRequestException("Marketing consent is given from the client's account");
    }
    if (!input.signatureName || input.signatureName.trim().length < 2) {
      throw new BadRequestException("Typed signature name required");
    }
    return this.prisma.consent.create({
      data: {
        tenantId: input.tenantId,
        clientId: input.clientId,
        formId: form.id,
        formVersion: form.version,
        formSnapshot: form.fields as any,
        responses: input.responses as any,
        signatureName: input.signatureName.trim(),
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
  async ensureMarketingForm(tenantId: string) {
    const existing = await this.prisma.consentForm.findFirst({
      where: { tenantId, purpose: MARKETING_PURPOSE, isActive: true },
      orderBy: { version: "desc" },
    });
    if (existing) return existing;
    return this.prisma.consentForm.create({
      data: {
        tenantId,
        name: MARKETING_FORM_NAME,
        description:
          "Elección de cada cliente sobre las comunicaciones comerciales. La gestiona el sistema.",
        fields: MARKETING_FIELDS as any,
        serviceIds: [],
        purpose: MARKETING_PURPOSE,
        version: 1,
      },
    });
  }

  /** The client's current choice, with the wording it was given for. */
  async getMarketingConsent(tenantId: string, clientId: string): Promise<MarketingConsentState> {
    const current = await this.prisma.consent.findFirst({
      where: { tenantId, clientId, revokedAt: null, form: { purpose: MARKETING_PURPOSE } },
      orderBy: { signedAt: "desc" },
      select: { responses: true, signedAt: true, formSnapshot: true },
    });
    return marketingStateOf(current);
  }

  /**
   * Records the client's choice. The previous record is revoked (kept, with
   * the reason) and a new one is signed with the client's name, the wording
   * shown and the hashed IP. Repeating the current choice records nothing.
   */
  async recordMarketingChoice(input: {
    tenantId: string;
    clientId: string;
    accepts: boolean;
    ip?: string;
  }): Promise<MarketingConsentState> {
    const client = await this.prisma.client.findFirst({
      where: { id: input.clientId, tenantId: input.tenantId },
      select: { firstName: true, lastName: true },
    });
    if (!client) throw new NotFoundException("Client not found");

    const current = await this.getMarketingConsent(input.tenantId, input.clientId);
    if (current.status === (input.accepts ? "granted" : "refused")) return current;

    const form = await this.ensureMarketingForm(input.tenantId);
    const now = new Date();
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.consent.updateMany({
        where: {
          tenantId: input.tenantId,
          clientId: input.clientId,
          revokedAt: null,
          form: { purpose: MARKETING_PURPOSE },
        },
        data: {
          revokedAt: now,
          revokeReason: input.accepts ? "superseded_by_client" : "withdrawn_by_client",
        },
      });
      return tx.consent.create({
        data: {
          tenantId: input.tenantId,
          clientId: input.clientId,
          formId: form.id,
          formVersion: form.version,
          formSnapshot: form.fields as any,
          responses: { [MARKETING_FIELD_ID]: input.accepts } as any,
          signatureName:
            `${client.firstName ?? ""} ${client.lastName ?? ""}`.trim() || "Cliente",
          signatureIpHash: this.encryption.hashIp(input.ip ?? ""),
          signedAt: now,
        },
        select: { responses: true, signedAt: true, formSnapshot: true },
      });
    });
    this.logger.log(
      `marketing consent ${input.accepts ? "granted" : "refused"} tenant=${input.tenantId} client=${input.clientId}`,
    );
    return marketingStateOf(created);
  }
}
