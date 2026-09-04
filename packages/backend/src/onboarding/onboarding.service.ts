import { Injectable, Logger, NotFoundException, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { OnboardingDetectorService } from "./onboarding-detector.service";
import { OnboardingGroup } from "@prisma/client";

interface StepStatusRecord {
  status: "pending" | "done" | "skipped" | "dismissed";
  completedAt?: string;
  skippedAt?: string;
  dismissedAt?: string;
}

export type { StepStatusRecord };

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly detector: OnboardingDetectorService,
  ) {}

  async getState(tenantId: string): Promise<{
    currentStep: number;
    steps: Record<string, StepStatusRecord>;
    checklistDismissed: boolean;
    finishedAt: Date | null;
    defs: any[];
    detectResults: Record<string, boolean>;
  }> {
    const defs = await this.prisma.onboardingStepDef.findMany({
      where: { enabled: true },
      orderBy: { order: "asc" },
    });
    const detectResults = await this.detector.detectAll(tenantId);
    const state = await this.prisma.onboardingState.findUnique({
      where: { tenantId },
    });
    const steps = ((state?.steps as unknown as Record<string, StepStatusRecord>) ?? {});
    return {
      currentStep: state?.currentStep ?? 0,
      steps,
      checklistDismissed: state?.checklistDismissed ?? false,
      finishedAt: state?.finishedAt ?? null,
      defs,
      detectResults,
    };
  }

  async skipStep(tenantId: string, stepKey: string) {
    const def = await this.prisma.onboardingStepDef.findUnique({
      where: { key: stepKey },
    });
    if (!def) throw new NotFoundException(`Unknown step ${stepKey}`);
    if (def.group === OnboardingGroup.linear_required) {
      throw new BadRequestException(
        `Step ${stepKey} is required and cannot be skipped`,
      );
    }
    const state = await this.prisma.onboardingState.findUnique({ where: { tenantId } });
    const steps = ((state?.steps as unknown as Record<string, StepStatusRecord>) ?? {});
    steps[stepKey] = {
      status: "skipped",
      skippedAt: new Date().toISOString(),
    };
    await this.prisma.onboardingState.upsert({
      where: { tenantId },
      create: {
        tenantId,
        steps: steps as any,
      },
      update: { steps: steps as any },
    });
    await this.detector.recomputeLinearStep(tenantId);
    return { ok: true };
  }

  async dismissChecklist(tenantId: string) {
    await this.prisma.onboardingState.upsert({
      where: { tenantId },
      create: {
        tenantId,
        checklistDismissed: true,
        steps: {},
      },
      update: { checklistDismissed: true },
    });
    return { ok: true };
  }

  async restoreChecklist(tenantId: string) {
    await this.prisma.onboardingState.upsert({
      where: { tenantId },
      create: {
        tenantId,
        checklistDismissed: false,
        steps: {},
      },
      update: { checklistDismissed: false },
    });
    return { ok: true };
  }

  // ==================== Sprint 2 / 2.1 — owner wizard ====================

  /**
   * Beauty-salon service templates used by the first step of the
   * owner-facing onboarding wizard. Plain data; the wizard renders
   * checkboxes so the owner can opt-in to seed any of them.
   */
  private readonly serviceTemplates = [
    { name: "Corte de cabello", durationMinutes: 30, price: 18 },
    { name: "Tinte / Coloración", durationMinutes: 90, price: 55 },
    { name: "Peinado", durationMinutes: 45, price: 30 },
    { name: "Manicura", durationMinutes: 45, price: 25 },
    { name: "Pedicura", durationMinutes: 60, price: 35 },
    { name: "Tratamiento facial", durationMinutes: 60, price: 55 },
    { name: "Depilación", durationMinutes: 30, price: 20 },
    { name: "Maquillaje", durationMinutes: 45, price: 40 },
  ];

  /**
   * Snapshot the wizard needs to render the first time the owner
   * lands on /dashboard/onboarding. Counts on services / staff /
   * appointments / openingHours decide which steps are still open.
   */
  async getWizard(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        currency: true,
        timezone: true,
        openingHours: true,
      },
    });
    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    const [services, professionals, appointments] = await Promise.all([
      this.prisma.service.count({ where: { tenantId } }),
      this.prisma.professional.count({ where: { tenantId } }),
      this.prisma.appointment.count({ where: { tenantId } }),
    ]);

    const hours = (tenant.openingHours as Record<string, unknown> | null) ?? {};
    const hasWorkingHours = Object.keys(hours).length > 0;

    return {
      tenantId: tenant.id,
      currency: tenant.currency || "EUR",
      timezone: tenant.timezone || "Europe/Madrid",
      hasServices: services > 0,
      hasStaff: professionals > 0,
      hasWorkingHours,
      hasFirstAppointment: appointments > 0,
      serviceTemplates: this.serviceTemplates,
    };
  }

  /**
   * Submit wizard data. Each step is independent; missing fields are
   * silently skipped so the owner can complete the wizard in any
   * order across multiple sessions. Returns the number of components
   * completed by this submission (0..3) out of 3 wizard steps.
   *
   * Sprint 2.3 follow-up (A1.2): when the operator supplied a
   * `firstAppointment` but the tenant has no `Professional`, the
   * appointment step is silently skipped server-side (FK constraint)
   * and the response surfaces `skipped.appointment = "no_staff"` so
   * the frontend can render a non-blocking warning instead of
   * falsely claiming the appointment was created.
   */
  async submitWizard(
    tenantId: string,
    payload: {
      services?: Array<{
        name: string;
        durationMinutes: number;
        price: number;
        description?: string;
      }>;
      firstAppointment?: {
        clientName: string;
        serviceName: string;
        date: string;
        time: string;
      };
      workingHours?: Record<string, { open: string; close: string } | null>;
    },
  ): Promise<{
    ok: true;
    completed: number;
    total: number;
    skipped: { appointment: "no_staff" | "no_service" | null };
  }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    let completed = 0;
    let appointmentSkipped: "no_staff" | "no_service" | null = null;

    // Step 2 — services
    if (payload.services?.length) {
      // Skip names that already exist on this tenant.
      const existing = await this.prisma.service.findMany({
        where: { tenantId },
        select: { name: true },
      });
      const existingNames = new Set(existing.map((s) => s.name.toLowerCase()));
      const toCreate = payload.services.filter(
        (s) => s.name && !existingNames.has(s.name.toLowerCase()),
      );
      if (toCreate.length > 0) {
        await this.prisma.service.createMany({
          data: toCreate.map((s) => ({
            tenantId,
            name: s.name,
            duration: s.durationMinutes,
            price: s.price,
            description: s.description ?? null,
            category: "OTHER" as any,
            isActive: true,
          })),
        });
        completed++;
      }
    }

    // Step 3 — working hours
    if (payload.workingHours && Object.keys(payload.workingHours).length > 0) {
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { openingHours: payload.workingHours as any },
      });
      completed++;
    }

    // Step 4 — first appointment. Requires a Client + Service + Professional.
    // If the tenant has no staff yet, skip the appointment creation
    // gracefully — the wizard's "Step 3: first appointment" remains
    // available after they add a team member.
    if (payload.firstAppointment) {
      const ap = payload.firstAppointment;
      const service = await this.prisma.service.findFirst({
        where: {
          tenantId,
          name: ap.serviceName,
        },
      });
      const professional = await this.prisma.professional.findFirst({
        where: { tenantId },
      });

      if (!service) {
        // Service name typed in the wizard doesn't match any seeded
        // service. Common when the owner writes the appointment for a
        // service they didn't tick in step 1.
        appointmentSkipped = "no_service";
      } else if (!professional) {
        // No team members yet — the appointment step can't be created
        // without a Professional FK. Surface this so the frontend can
        // render "añade un miembro del equipo primero" instead of
        // silently dropping the input.
        appointmentSkipped = "no_staff";
      } else {
        // Step 4 — first appointment. Requires a Client + Service + Professional.
        // Find or create the client by name (minimal data — wizard
        // doesn't ask for email/phone; that's the regular flow).
        const trimmedName = ap.clientName.trim();
        const firstSpace = trimmedName.indexOf(" ");
        const firstName =
          firstSpace > 0 ? trimmedName.slice(0, firstSpace) : trimmedName;
        const lastName = firstSpace > 0 ? trimmedName.slice(firstSpace + 1) : "";

        let client = await this.prisma.client.findFirst({
          where: { tenantId, firstName, lastName },
        });
        if (!client) {
          client = await this.prisma.client.create({
            data: {
              tenantId,
              firstName,
              lastName,
              email: `wizard-${Date.now()}@placeholder.local`,
            },
          });
        }

        // Compose the start date from date + time. The DB also wants
        // scheduledDate (DateTime), scheduledTime ("HH:mm"), duration
        // (Int minutes), endTime ("HH:mm") — derived from the inputs.
        const startAt = new Date(`${ap.date}T${ap.time}:00`);
        const           endAt = new Date(
          startAt.getTime() + service.duration * 60_000,
        );
        const pad = (n: number) => String(n).padStart(2, "0");
        const endTimeStr = `${pad(endAt.getHours())}:${pad(endAt.getMinutes())}`;

        const tenant = await this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { currency: true },
        });

        await this.prisma.appointment.create({
          data: {
            tenantId,
            clientId: client.id,
            serviceId: service.id,
            professionalId: professional.id,
            scheduledDate: startAt,
            scheduledTime: ap.time,
            duration: service.duration,
            endTime: endTimeStr,
            startTime: startAt,
            status: "confirmed",
            paymentStatus: "pending",
            price: service.price,
            currency: tenant?.currency || "EUR",
            totalAmount: service.price,
            amountDue: service.price,
            notes: "Created from onboarding wizard",
          },
        });
        completed++;
      }
    }

    return {
      ok: true,
      completed,
      total: 3,
      skipped: { appointment: appointmentSkipped },
    };
  }
}