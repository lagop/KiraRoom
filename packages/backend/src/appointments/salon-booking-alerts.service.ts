import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../common/prisma/prisma.service";
import { runUnscoped } from "../common/tenancy/tenant.context";
import { EmailService } from "../notifications/services/email.service";
import { NotificationsService } from "../notifications/notifications.service";
import { clockOf } from "./visit-totals";
import { isTestBooking } from "../onboarding/test-booking";

/**
 * The per-user preference key (NotificationPreference.preferences, email
 * channel) for these alerts. Default on (DEFAULT_PREFERENCES).
 */
export const SALON_BOOKING_ALERT = "salon_booking_alert";

/** Who gets them: the salon's managers. */
const ALERT_ROLES = ["owner", "admin"] as const;

/**
 * Audit 7 D12: the salon's owner and admins learn by email when a client
 * books online (salon page, widget, virtual receptionist: bookOnline) and
 * when she cancels her appointment herself (the cancel link). Short, in
 * Spanish, with a link to the appointment. Each user turns them off in
 * Ajustes > Seguridad. Never fails the booking or the cancellation: a
 * failure is logged.
 */
@Injectable()
export class SalonBookingAlertsService {
  private readonly logger = new Logger(SalonBookingAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /** Returns how many were sent (for tests and logs). */
  async notify(kind: "booked" | "cancelled", appointmentId: string): Promise<number> {
    try {
      return await this.send(kind, appointmentId);
    } catch (err) {
      this.logger.warn(`Salon ${kind} alert for appointment ${appointmentId} not sent: ${(err as Error).message}`);
      return 0;
    }
  }

  private async send(kind: "booked" | "cancelled", appointmentId: string): Promise<number> {
    const appointment: any = await runUnscoped(() =>
      (this.prisma.appointment.findUnique as any)({
        where: { id: appointmentId },
        include: {
          client: { select: { firstName: true, lastName: true, isTest: true } },
          service: { select: { name: true } },
          professional: { select: { firstName: true } },
          tenant: { select: { name: true, timezone: true, deletedAt: true } },
        },
      }),
    );
    // The onboarding's test booking is nobody's news (onboarding/test-booking.ts).
    if (!appointment || appointment.tenant?.deletedAt || isTestBooking(appointment)) return 0;

    const users: Array<{ id: string; email: string }> = await runUnscoped(() =>
      this.prisma.user.findMany({
        where: { tenantId: appointment.tenantId, role: { in: [...ALERT_ROLES] as any }, isActive: true },
        select: { id: true, email: true },
      }),
    );
    if (users.length === 0) return 0;

    const tz = appointment.tenant?.timezone || "Europe/Madrid";
    const clientName =
      [appointment.client?.firstName, appointment.client?.lastName].filter(Boolean).join(" ").trim() || "Una clienta";
    const base = (
      this.config.get<string>("APP_BASE_URL") ||
      this.config.get<string>("FRONTEND_URL") ||
      "https://app.kiraroom.net"
    ).replace(/\/+$/, "");
    const details = {
      kind,
      tenantName: appointment.tenant?.name || "tu salón",
      clientName,
      serviceName: appointment.serviceName || appointment.service?.name || null,
      professionalName: appointment.professional?.firstName || null,
      date: new Date(appointment.scheduledDate).toISOString().slice(0, 10),
      time: appointment.scheduledTime ? clockOf(appointment.scheduledTime, tz) ?? appointment.scheduledTime : null,
      appointmentUrl: `${base}/dashboard/appointments/${appointment.id}`,
      settingsUrl: `${base}/dashboard/settings/seguridad`,
    };

    let sent = 0;
    for (const user of users) {
      if (!user.email) continue;
      if (!(await this.notifications.shouldSendNotificationForUser(user.id, SALON_BOOKING_ALERT, "email"))) continue;
      const result = await this.email.sendSalonBookingAlert({ to: user.email, ...details });
      if (result.success) sent += 1;
      else if (!result.skipped) this.logger.warn(`Salon ${kind} alert to user ${user.id} failed: ${result.error}`);
    }
    return sent;
  }
}
