import { Injectable, NotFoundException, BadRequestException, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { EncryptionService } from "../common/encryption/encryption.service";

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
      where: { tenantId },
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
    await this.prisma.consentForm.delete({ where: { id } });
    return { deleted: true };
  }

  async getRequiredForms(tenantId: string, serviceId?: string) {
    const forms = await this.prisma.consentForm.findMany({
      where: {
        tenantId,
        isActive: true,
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
}