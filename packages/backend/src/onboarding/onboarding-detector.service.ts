import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { ProductEventsService, PRODUCT_EVENTS } from "../common/telemetry/product-events.service";
import { AppointmentSource, OnboardingGroup } from "@prisma/client";

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: ProductEventsService,
  ) {}

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
      case "hasCoverImageAndDescription":
        return this.hasCoverImageAndDescription(tenantId);
      // hasActiveReminderTemplate: the old name, until the seeder rewrites
      // the step definition.
      case "hasReminderChannel":
      case "hasActiveReminderTemplate":
        return this.hasReminderChannel(tenantId);
      case "hasClients":
        return this.hasClients(tenantId);
      case "hasFirstBooking":
        return this.hasFirstBooking(tenantId);
      case "hasWidgetOrQr":
        return this.hasWidgetOrQr(tenantId);
      case "hasWhatsAppConnection":
        return this.hasWhatsAppConnection(tenantId);
      case "hasLegalData":
        return this.hasLegalData(tenantId);
      default:
        this.logger.warn(`Unknown detector: ${name}`);
        return false;
    }
  }

  /**
   * Step 1 of the blocking wizard. The logo is deliberately NOT required
   * here: it used to be, and it gated the whole dashboard behind an image
   * upload that a salon signing up from a phone rarely has to hand. The
   * logo now lives in the optional `branding` checklist step, next to the
   * cover image, where it belongs.
   */
  private async hasBusinessIdentity(tenantId: string): Promise<boolean> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        name: true,
        street: true,
        city: true,
        phone: true,
      },
    });
    if (!t) return false;
    return Boolean(t.name && t.street && t.city && t.phone);
  }

  /** D15: razón social, NIF and the salon's contact email are all set. */
  private async hasLegalData(tenantId: string): Promise<boolean> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { legalName: true, taxId: true, email: true },
    });
    if (!t) return false;
    return Boolean(t.legalName?.trim() && t.taxId?.trim() && t.email?.trim());
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

  private async hasCoverImageAndDescription(tenantId: string): Promise<boolean> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { coverImage: true, description: true },
    });
    if (!t) return false;
    return Boolean(t.coverImage && (t.description?.length ?? 0) > 20);
  }

  /**
   * Reminders reach the salon's clients: by email, which the scheduler sends
   * on its own 24 h and 1 h before to any client with a real address, or by
   * WhatsApp from the salon's own connected number. The step used to count
   * NotificationTemplate rows, which nothing in KiraRoom creates, so it was
   * pending for ever.
   */
  private async hasReminderChannel(tenantId: string): Promise<boolean> {
    const whatsapp = await this.prisma.whatsAppConnection.findFirst({
      where: { tenantId, isActive: true },
      select: { id: true },
    });
    if (whatsapp) return true;
    const reachable = await this.prisma.client.findFirst({
      where: {
        tenantId,
        email: { contains: "@" },
        NOT: [
          { email: { endsWith: ".local", mode: "insensitive" } },
          { email: { endsWith: ".localhost", mode: "insensitive" } },
          { email: { endsWith: ".invalid", mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    return Boolean(reachable);
  }

  private async hasClients(tenantId: string): Promise<boolean> {
    // The wizard's test client is not one of hers (D27).
    const count = await this.prisma.client.count({ where: { tenantId, isTest: false } });
    return count >= 1;
  }

  /** The activation milestone: a real booking exists (the wizard's test one is not, D27). */
  private async hasFirstBooking(tenantId: string): Promise<boolean> {
    const count = await this.prisma.appointment.count({ where: { tenantId, isTest: false } });
    return count >= 1;
  }

  /**
   * "Publica tu widget o QR": a widget for the salon's website, the QR or
   * the booking link taken from Compartir (downloaded, copied or shared,
   * recorded as a BOOKING_LINK_SHARED event), or an online booking already
   * in. It only counted widgets, so a salon without a website never got it
   * done unless it pressed "Omitir" (O10).
   */
  private async hasWidgetOrQr(tenantId: string): Promise<boolean> {
    const widgets = await this.prisma.widgetInstance.count({ where: { tenantId } });
    if (widgets >= 1) return true;
    const shared = await this.prisma.productEvent.findFirst({
      where: { tenantId, name: PRODUCT_EVENTS.BOOKING_LINK_SHARED },
      select: { id: true },
    });
    if (shared) return true;
    const online = await this.prisma.appointment.findFirst({
      where: { tenantId, isTest: false, source: { in: [AppointmentSource.online, AppointmentSource.widget] } },
      select: { id: true },
    });
    return Boolean(online);
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
    // finishedAt is when the wizard was first completed: kept once set (it
    // used to be rewritten to "now" on every poll, so the SaaS console showed
    // the last visit). A row already up to date is not written again: this
    // runs on every state read.
    const finishedAt = finished ? state?.finishedAt ?? new Date() : null;
    const unchanged =
      !!state &&
      state.currentStep === nextStep &&
      (state.finishedAt?.getTime?.() ?? null) === (finishedAt?.getTime() ?? null);
    if (!unchanged) {
      await this.prisma.onboardingState.upsert({
        where: { tenantId },
        create: {
          tenantId,
          currentStep: nextStep,
          finishedAt,
          steps: (steps as any) || {},
        },
        update: {
          currentStep: nextStep,
          finishedAt,
        },
      });
    }

    // Second funnel milestone: the blocking wizard is done, so the tenant
    // can actually see the product. recordOnce because recompute runs on
    // every step transition.
    if (finished) {
      await this.events.recordOnce(PRODUCT_EVENTS.ONBOARDING_COMPLETED, tenantId, {
        steps: defs.length,
      });
    }
  }
}