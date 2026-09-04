import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { OnboardingGroup } from "@prisma/client";

type StepStatus = "pending" | "done" | "skipped" | "dismissed";

interface StepStatusRecord {
  status: StepStatus;
  completedAt?: string;
  skippedAt?: string;
  dismissedAt?: string;
}

@Injectable()
export class OnboardingDetectorService {
  private readonly logger = new Logger(OnboardingDetectorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Detect all step states for a tenant and persist any transitions.
   * Returns the fresh detection map: { stepKey: boolean }.
   */
  async detectAll(tenantId: string): Promise<Record<string, boolean>> {
    const defs = await this.prisma.onboardingStepDef.findMany({
      where: { enabled: true },
      orderBy: { order: "asc" },
    });
    const results: Record<string, boolean> = {};
    for (const def of defs) {
      try {
        results[def.key] = await this.runDetector(tenantId, def.detectName);
      } catch (err) {
        this.logger.warn(
          `Detector ${def.detectName} failed for tenant ${tenantId}: ${(err as Error).message}`,
        );
        results[def.key] = false;
      }
    }
    await this.applyDetection(tenantId, results);
    return results;
  }

  /**
   * Detect a single step. Returns the boolean result and updates state if it
   * flipped to "done".
   */
  async detect(tenantId: string, stepKey: string): Promise<boolean> {
    const def = await this.prisma.onboardingStepDef.findUnique({
      where: { key: stepKey },
    });
    if (!def) return false;
    const result = await this.runDetector(tenantId, def.detectName);
    await this.applyDetection(tenantId, { [stepKey]: result });
    return result;
  }

  /**
   * Programmatically mark a step as done (e.g., after a successful service
   * create). Idempotent — calling repeatedly with the same step is safe.
   */
  async markStepCompleted(tenantId: string, stepKey: string): Promise<void> {
    await this.upsertState(tenantId, stepKey, {
      status: "done",
      completedAt: new Date().toISOString(),
    });
    this.logger.debug(`Marked onboarding step ${stepKey} done for tenant ${tenantId}`);
  }

  // ----- private -----

  private async runDetector(tenantId: string, name: string): Promise<boolean> {
    switch (name) {
      case "hasBusinessIdentity":
        return this.hasBusinessIdentity(tenantId);
      case "hasFirstService":
        return this.hasFirstService(tenantId);
      case "allProsHaveWorkingHours":
        return this.allProsHaveWorkingHours(tenantId);
      case "hasStripeCustomer":
        return this.hasStripeCustomer(tenantId);
      case "hasCoverImageAndDescription":
        return this.hasCoverImageAndDescription(tenantId);
      case "hasActiveReminderTemplate":
        return this.hasActiveReminderTemplate(tenantId);
      case "hasWidgetOrQr":
        return this.hasWidgetOrQr(tenantId);
      case "hasWhatsAppConnection":
        return this.hasWhatsAppConnection(tenantId);
      default:
        this.logger.warn(`Unknown detector: ${name}`);
        return false;
    }
  }

  private async hasBusinessIdentity(tenantId: string): Promise<boolean> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        street: true,
        city: true,
        phone: true,
        logo: true,
      },
    });
    if (!t) return false;
    return Boolean(t.name && t.street && t.city && t.phone && t.logo);
  }

  private async hasFirstService(tenantId: string): Promise<boolean> {
    const count = await this.prisma.service.count({ where: { tenantId } });
    return count >= 1;
  }

  private async allProsHaveWorkingHours(tenantId: string): Promise<boolean> {
    const pros = await this.prisma.professional.findMany({
      where: { tenantId, isActive: true },
      select: { workingHours: true },
    });
    if (pros.length === 0) return false;
    return pros.every((p) => {
      const hours = p.workingHours as unknown;
      // Tolerate BOTH legacy and current shapes:
      //   - Legacy (seed.ts): { monday: { start, end }, tuesday: {...}, ... }
      //   - Current (wizard / DTO example): [{ day, openTime, closeTime }, ...]
      // Either is accepted as long as it represents at least one working
      // day. An empty array or empty object is treated as "not configured".
      if (Array.isArray(hours)) {
        return hours.length > 0;
      }
      if (hours && typeof hours === "object") {
        return Object.values(hours as Record<string, unknown>).some(
          (v) => v !== null && v !== undefined,
        );
      }
      return false;
    });
  }

  private async hasStripeCustomer(tenantId: string): Promise<boolean> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeCustomerId: true },
    });
    return Boolean(t?.stripeCustomerId);
  }

  private async hasCoverImageAndDescription(tenantId: string): Promise<boolean> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { coverImage: true, description: true },
    });
    if (!t) return false;
    return Boolean(t.coverImage && (t.description?.length ?? 0) > 20);
  }

  private async hasActiveReminderTemplate(tenantId: string): Promise<boolean> {
    const count = await this.prisma.notificationTemplate.count({
      where: {
        tenantId,
        isActive: true,
        type: { in: ["appointment_reminder_24h", "appointment_reminder_1h"] as any },
      },
    });
    return count > 0;
  }

  private async hasWidgetOrQr(tenantId: string): Promise<boolean> {
    const widgets = await this.prisma.widgetInstance.count({ where: { tenantId } });
    return widgets >= 1;
  }

  private async hasWhatsAppConnection(tenantId: string): Promise<boolean> {
    const conn = await this.prisma.whatsAppConnection.findFirst({
      where: { tenantId, isActive: true },
      select: { id: true },
    });
    return Boolean(conn);
  }

  private async applyDetection(
    tenantId: string,
    results: Record<string, boolean>,
  ): Promise<void> {
    for (const [key, passed] of Object.entries(results)) {
      if (!passed) continue;
      await this.upsertState(tenantId, key, {
        status: "done",
        completedAt: new Date().toISOString(),
      });
    }
    await this.recomputeLinearStep(tenantId);
  }

  private async upsertState(
    tenantId: string,
    stepKey: string,
    patch: StepStatusRecord,
  ): Promise<void> {
    const existing = await this.prisma.onboardingState.findUnique({
      where: { tenantId },
    });
    const steps = ((existing?.steps as unknown as Record<string, StepStatusRecord>) ?? {});
    // Don't downgrade 'skipped' or 'dismissed' to 'done' automatically — only
    // promote 'pending' or 'done' (idempotent).
    const prev = steps[stepKey];
    if (prev && prev.status !== "pending" && patch.status === "done") {
      return;
    }
    steps[stepKey] = patch;
    await this.prisma.onboardingState.upsert({
      where: { tenantId },
      create: {
        tenantId,
        steps: steps as any,
      },
      update: {
        steps: steps as any,
      },
    });
  }

  /**
   * Recompute `currentStep` to be the lowest-order linear_required step that
   * is not yet done/skipped. Once all linear_required steps are completed,
   * mark `finishedAt`.
   */
  async recomputeLinearStep(tenantId: string): Promise<void> {
    const defs = await this.prisma.onboardingStepDef.findMany({
      where: { enabled: true, group: OnboardingGroup.linear_required },
      orderBy: { order: "asc" },
    });
    const state = await this.prisma.onboardingState.findUnique({ where: { tenantId } });
    const steps = ((state?.steps as unknown as Record<string, StepStatusRecord>) ?? {});
    let nextStep = 0;
    for (let i = 0; i < defs.length; i++) {
      const s = steps[defs[i].key];
      if (!s || s.status === "pending") {
        nextStep = i;
        break;
      }
      nextStep = i + 1;
    }
    const finished = nextStep >= defs.length;
    await this.prisma.onboardingState.upsert({
      where: { tenantId },
      create: {
        tenantId,
        currentStep: nextStep,
        finishedAt: finished ? new Date() : null,
        steps: (steps as any) || {},
      },
      update: {
        currentStep: nextStep,
        finishedAt: finished ? new Date() : null,
      },
    });
  }
}