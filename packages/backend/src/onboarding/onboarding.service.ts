import { Injectable, Logger, NotFoundException, BadRequestException, Optional } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { OnboardingDetectorService } from "./onboarding-detector.service";
import { ProductEventsService, PRODUCT_EVENTS } from "../common/telemetry/product-events.service";
import { OnboardingGroup, Prisma } from "@prisma/client";
import { salonInstant } from "../appointments/salon-time";
import { appointmentLocationId } from "../multi-location/appointment-location";
import { placeholderEmail } from "../common/placeholder-email";
import { workingHoursProblem } from "../professionals/working-hours-input";
import { salonHoursEntries } from "../appointments/working-hours";
import { categoryFor } from "../import/columns";
import { randomUUID } from "crypto";

interface StepStatusRecord {
  status: "pending" | "done" | "skipped" | "dismissed";
  completedAt?: string;
  skippedAt?: string;
  dismissedAt?: string;
}

export type { StepStatusRecord };

const WIZARD_DAYS: ReadonlyArray<[string, string]> = [
  ["mon", "monday"],
  ["tue", "tuesday"],
  ["wed", "wednesday"],
  ["thu", "thursday"],
  ["fri", "friday"],
  ["sat", "saturday"],
  ["sun", "sunday"],
];

/**
 * The wizard's week (`{ mon: { open, close } | null, ... }`, a closed day
 * absent or null) as the salon's opening hours are stored: one entry per open
 * day, Monday first. The DTO has already checked each time is HH:MM.
 */
export function wizardWeekToEntries(
  week: Record<string, { open: string; close: string } | null> | undefined,
): Array<{ day: string; openTime: string; closeTime: string }> {
  if (!week) return [];
  return WIZARD_DAYS.flatMap(([key, day]) => {
    const hours = week[key];
    return hours ? [{ day, openTime: hours.open, closeTime: hours.close }] : [];
  });
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly detector: OnboardingDetectorService,
    @Optional() private readonly events?: ProductEventsService,
  ) {}

  /**
   * The salon took its booking link or QR from Compartir (downloaded the QR,
   * copied or shared the link): that is "Publica tu widget o QR" done for a
   * salon without a website (O10). Recorded once; the step is then detected.
   */
  async recordBookingLinkShared(tenantId: string, how: string): Promise<{ ok: true }> {
    await this.events?.recordOnce(PRODUCT_EVENTS.BOOKING_LINK_SHARED, tenantId, { how });
    await this.detector.detect(tenantId, "widget_qr_setup");
    return { ok: true };
  }

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

    const [salonServices, professionals, appointments] = await Promise.all([
      this.prisma.service.findMany({
        where: { tenantId },
        select: { id: true, name: true, isActive: true },
        orderBy: { name: "asc" },
      }),
      // Only an active professional can take the test booking.
      this.prisma.professional.count({ where: { tenantId, isActive: true } }),
      this.prisma.appointment.count({ where: { tenantId } }),
    ]);
    const services = salonServices.length;

    // The salon's week as availability reads it (list format, or the old
    // { open, close } pair). Sent to the wizard so its editor starts from
    // the saved hours instead of Monday-Friday 09-19, which saving used to
    // write over whatever the owner had set in Ajustes.
    const openingHours = salonHoursEntries(tenant.openingHours) ?? [];
    const hasWorkingHours = openingHours.length > 0;

    return {
      tenantId: tenant.id,
      currency: tenant.currency || "EUR",
      timezone: tenant.timezone || "Europe/Madrid",
      hasServices: services > 0,
      hasStaff: professionals > 0,
      hasWorkingHours,
      openingHours,
      hasFirstAppointment: appointments > 0,
      serviceTemplates: this.serviceTemplates,
      // The salon's own active services, for the test booking's service
      // picker (it used to be the first ticked template, or "Corte de
      // cabello", which most salons do not have; O4).
      services: salonServices.filter((s) => s.isActive).map((s) => ({ id: s.id, name: s.name })),
    };
  }

  /**
   * Submit wizard data. Each step is optional: a field left out is not
   * saved, so the owner can fill the wizard in any order across several
   * visits. Returns what this submission actually saved (`saved`) and why
   * the test booking was not created when it was asked for (`skipped`).
   *
   * Everything is checked first and then written in one transaction: the
   * services, the salon's hours and the test booking are saved together or
   * not at all. (The services used to be created with category "OTHER",
   * which the database refuses, so ticking any service failed the whole
   * submission; O1.)
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
      /** The week in the list format (shifts); wins over `workingHours`. */
      openingHours?: Array<{ day: string; openTime: string; closeTime: string }>;
    },
    now: Date = new Date(),
  ): Promise<{
    ok: true;
    completed: number;
    total: number;
    saved: { services: number; hours: boolean; appointment: boolean };
    skipped: { appointment: "no_staff" | "no_service" | null };
  }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, currency: true, timezone: true },
    });
    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }
    const timeZone = tenant.timezone || "Europe/Madrid";
    // Checked before writing anything, so a bad date does not leave the
    // other steps half saved. (The controller validates the body too.)
    const ap = payload.firstAppointment;
    if (
      ap &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(String(ap.date ?? "").slice(0, 10)) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(ap.time ?? "")))
    ) {
      throw new BadRequestException("Fecha u hora de la primera cita no válidas");
    }
    // A day that closes before it opens would be read as closed: refused
    // with the reason instead, before anything is written.
    const openingWeek = payload.openingHours ?? wizardWeekToEntries(payload.workingHours);
    const hoursProblem = openingWeek.length > 0 ? workingHoursProblem(openingWeek) : null;
    if (hoursProblem) throw new BadRequestException(hoursProblem);

    // Services: not the ones the salon already has, and each name once (a
    // template ticked and typed again as a custom service was created
    // twice; O13). Compared without case or surrounding spaces.
    const toCreate: WizardNewService[] = [];
    let existingServices: WizardExistingService[] = [];
    if (payload.services?.length || ap) {
      existingServices = await this.prisma.service.findMany({
        where: { tenantId },
        select: { id: true, name: true, duration: true, price: true, isActive: true },
      });
    }
    if (payload.services?.length) {
      const taken = new Set(existingServices.map((s) => serviceNameKey(s.name)));
      for (const s of payload.services) {
        const name = (s.name ?? "").trim();
        const key = serviceNameKey(name);
        if (!key || taken.has(key)) continue;
        taken.add(key);
        toCreate.push({
          name,
          duration: s.durationMinutes,
          price: s.price,
          description: s.description ?? null,
        });
      }
    }

    // The test booking: everything it needs is worked out now, so a past
    // date or a taken slot is refused before any step is saved (O12).
    let appointmentSkipped: "no_staff" | "no_service" | null = null;
    let booking: {
      service: WizardExistingService | WizardNewService;
      professionalId: string;
      locationId: string | null;
      day: string;
      time: string;
      startAt: Date;
      endTime: string;
    } | null = null;
    if (ap) {
      const key = serviceNameKey(ap.serviceName);
      // Looked up as the duplicates are, without case (O13): an active one
      // the salon has, else one this submission creates.
      const service =
        existingServices.find((s) => s.isActive && serviceNameKey(s.name) === key) ??
        toCreate.find((s) => serviceNameKey(s.name) === key) ??
        null;
      if (!service) {
        appointmentSkipped = "no_service";
      } else {
        const professional = await this.pickProfessional(tenantId, "id" in service ? service.id : undefined);
        if (!professional) {
          appointmentSkipped = "no_staff";
        } else {
          const day = ap.date.slice(0, 10);
          const startAt = salonInstant(day, ap.time, timeZone);
          if (startAt.getTime() < now.getTime()) {
            throw new BadRequestException(
              "La cita de prueba tiene que ser a partir de ahora: elige otra fecha u hora.",
            );
          }
          const start = toMinutes(ap.time);
          const end = start + service.duration;
          const clash = await this.slotTaken(tenantId, professional.id, day, start, end);
          if (clash) {
            throw new BadRequestException(
              `${professional.name} ya tiene una cita a las ${clash} ese día. Elige otra hora para la cita de prueba.`,
            );
          }
          booking = {
            service,
            professionalId: professional.id,
            locationId: await appointmentLocationId(this.prisma, tenantId, professional.id),
            day,
            time: ap.time,
            startAt,
            endTime: fromMinutes(end % (24 * 60)),
          };
        }
      }
    }

    const saved = { services: 0, hours: false, appointment: false };
    await this.prisma.$transaction(async (tx) => {
      const createdIds = new Map<string, string>();
      for (const s of toCreate) {
        const row = await tx.service.create({
          data: {
            tenantId,
            name: s.name,
            duration: s.duration,
            price: s.price,
            description: s.description,
            // "Manicura" is nails, "Corte de cabello" hair, as the importer
            // files them (columns.ts): always a value the enum has.
            category: categoryFor(s.name),
            isActive: true,
          },
          select: { id: true },
        });
        createdIds.set(serviceNameKey(s.name), row.id);
        saved.services++;
      }

      // Working hours: the salon's own week in the list format the settings
      // page edits and availability reads (working-hours.ts salonHoursEntries).
      if (openingWeek.length > 0) {
        await tx.tenant.update({
          where: { id: tenantId },
          data: { openingHours: openingWeek as any },
        });
        saved.hours = true;
      }

      if (booking && ap) {
        const serviceId =
          "id" in booking.service ? booking.service.id : createdIds.get(serviceNameKey(booking.service.name));
        if (!serviceId) throw new Error("wizard service not created");
        const trimmedName = ap.clientName.trim();
        const firstSpace = trimmedName.indexOf(" ");
        const firstName = firstSpace > 0 ? trimmedName.slice(0, firstSpace) : trimmedName;
        const lastName = firstSpace > 0 ? trimmedName.slice(firstSpace + 1) : "";
        // Always a test client of its own, even when a real client has the
        // same name: the booking used to go on her, and she was sent the
        // reminder of an appointment that did not exist (O5). No contact
        // details, so nothing can reach anyone; deleted with the booking (D27).
        const client = await tx.client.create({
          data: {
            tenantId,
            firstName,
            lastName,
            email: placeholderEmail(`wizard-${randomUUID()}`),
            isTest: true,
          },
          select: { id: true },
        });
        // Stored like every other booking (AppointmentsService.insertAppointment):
        // scheduledDate is the calendar day at UTC midnight plus the
        // wall-clock scheduledTime, and startTime is the real instant in the
        // SALON's timezone. Service.price is in euros; appointment amounts
        // are in cents, as in every other booking path.
        const totalCents = Math.round(Number(booking.service.price) * 100);
        await tx.appointment.create({
          data: {
            tenantId,
            clientId: client.id,
            serviceId,
            professionalId: booking.professionalId,
            scheduledDate: new Date(booking.day),
            scheduledTime: booking.time,
            duration: booking.service.duration,
            endTime: booking.endTime,
            startTime: booking.startAt,
            status: "confirmed",
            paymentStatus: "pending",
            price: booking.service.price,
            currency: tenant.currency || "EUR",
            totalAmount: totalCents,
            amountDue: totalCents,
            // The service as booked (appointment-snapshot.ts).
            serviceName: booking.service.name,
            servicePrice: booking.service.price,
            serviceDuration: booking.service.duration,
            locationId: booking.locationId,
            // D27: a test booking. It shows in the agenda marked "Prueba",
            // stays out of every figure and of every message to clients
            // (reminders, review requests, the wait list...; isTestBooking),
            // and the cleanup job deletes it the next salon day.
            isTest: true,
            notes: "Cita de prueba del configurador: se borra sola mañana si no se cobra ni se factura.",
          },
        });
        saved.appointment = true;
      }
    });

    const completed = (saved.services > 0 ? 1 : 0) + (saved.hours ? 1 : 0) + (saved.appointment ? 1 : 0);
    return {
      ok: true,
      completed,
      total: 3,
      saved,
      skipped: { appointment: appointmentSkipped },
    };
  }

  /**
   * Who the test booking goes to: an active professional, one who does the
   * service when someone does. It used to be the first row found, which
   * could be a professional no longer at the salon (O5).
   */
  private async pickProfessional(
    tenantId: string,
    serviceId: string | undefined,
  ): Promise<{ id: string; name: string } | null> {
    const select = { id: true, firstName: true, lastName: true } as const;
    const named = (p: { id: string; firstName: string; lastName: string } | null) =>
      p ? { id: p.id, name: `${p.firstName} ${p.lastName ?? ""}`.trim() } : null;
    if (serviceId) {
      const doesIt = await this.prisma.professional.findFirst({
        where: { tenantId, isActive: true, services: { some: { serviceId } } },
        select,
        orderBy: { createdAt: "asc" },
      });
      if (doesIt) return named(doesIt);
    }
    return named(
      await this.prisma.professional.findFirst({
        where: { tenantId, isActive: true },
        select,
        orderBy: { createdAt: "asc" },
      }),
    );
  }

  /**
   * The start ("HH:MM") of an appointment of this professional overlapping
   * [start, end) minutes on `day`, or null when the slot is free. Cancelled
   * and no-show appointments do not hold their slot.
   */
  private async slotTaken(
    tenantId: string,
    professionalId: string,
    day: string,
    start: number,
    end: number,
  ): Promise<string | null> {
    const sameDay = await this.prisma.appointment.findMany({
      where: {
        tenantId,
        professionalId,
        scheduledDate: new Date(day),
        status: { notIn: ["cancelled", "no_show"] },
      },
      select: { scheduledTime: true, duration: true },
    });
    for (const a of sameDay) {
      if (!/^\d{1,2}:\d{2}/.test(a.scheduledTime ?? "")) continue;
      const s = toMinutes(a.scheduledTime);
      const e = s + (a.duration || 0);
      if (s < end && start < e) return a.scheduledTime.slice(0, 5);
    }
    return null;
  }
}

interface WizardExistingService {
  id: string;
  name: string;
  duration: number;
  price: Prisma.Decimal | number;
  isActive: boolean;
}

interface WizardNewService {
  name: string;
  duration: number;
  price: number;
  description: string | null;
}

/** How service names are compared: no case, no surrounding or doubled spaces. */
export function serviceNameKey(name: string | null | undefined): string {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(total: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
