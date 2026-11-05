import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { OnboardingGroup } from "@prisma/client";

const DEFAULT_STEP_DEFS: Array<{
  key: string;
  order: number;
  group: OnboardingGroup;
  titleI18nKey: string;
  descI18nKey: string;
  href: string | null;
  detectName: string;
}> = [
  {
    key: "workspace_business",
    order: 1,
    group: OnboardingGroup.linear_required,
    titleI18nKey: "onboarding.workspace_business.title",
    descI18nKey: "onboarding.workspace_business.desc",
    href: "/dashboard/settings/salon",
    detectName: "hasBusinessIdentity",
  },
  {
    key: "service_create",
    order: 2,
    group: OnboardingGroup.linear_required,
    titleI18nKey: "onboarding.service_create.title",
    descI18nKey: "onboarding.service_create.desc",
    href: "/dashboard/services/new",
    detectName: "hasFirstService",
  },
  {
    key: "schedule_set",
    order: 3,
    group: OnboardingGroup.linear_required,
    titleI18nKey: "onboarding.schedule_set.title",
    descI18nKey: "onboarding.schedule_set.desc",
    href: "/dashboard/professionals",
    detectName: "allProsHaveWorkingHours",
  },
  {
    // The CSV importer exists, with dry-run and a downloadable template,
    // and the marketing site sells it as "migration in 30 seconds" -- but
    // it was not in the checklist at all, so nobody was pointed at it.
    key: "clients_import",
    order: 5,
    group: OnboardingGroup.checklist_optional,
    titleI18nKey: "onboarding.clients_import.title",
    descI18nKey: "onboarding.clients_import.desc",
    href: "/dashboard/clients/import",
    detectName: "hasClients",
  },
  {
    // The real activation moment. Without it the checklist called
    // onboarding finished for a salon that had never seen a booking.
    key: "first_booking",
    order: 6,
    group: OnboardingGroup.checklist_optional,
    titleI18nKey: "onboarding.first_booking.title",
    descI18nKey: "onboarding.first_booking.desc",
    // "Comparte tu enlace o tu QR": where the link and the QR are (O10).
    href: "/dashboard/compartir",
    detectName: "hasFirstBooking",
  },
  {
    // D15: the salon's legal data (razón social, NIF) and contact email: the
    // aviso legal of its web page and every invoice need them. Done once all
    // three are set; nothing is blocked while they are missing.
    key: "legal_data",
    order: 9,
    group: OnboardingGroup.checklist_optional,
    titleI18nKey: "onboarding.legal_data.title",
    descI18nKey: "onboarding.legal_data.desc",
    href: "/dashboard/settings/fiscal",
    detectName: "hasLegalData",
  },
  {
    key: "branding",
    order: 10,
    group: OnboardingGroup.checklist_optional,
    titleI18nKey: "onboarding.branding.title",
    descI18nKey: "onboarding.branding.desc",
    href: "/dashboard/settings/salon#branding",
    detectName: "hasCoverImageAndDescription",
  },
  {
    key: "reminders_enabled",
    order: 7,
    group: OnboardingGroup.checklist_optional,
    titleI18nKey: "onboarding.reminders_enabled.title",
    descI18nKey: "onboarding.reminders_enabled.desc",
    // Reminders go by email on their own to every client with an email
    // (NotificationsScheduler); the one thing the salon can add is WhatsApp
    // from its own number. The step used to count NotificationTemplate rows,
    // which nothing creates, and link to the notification inbox.
    href: "/dashboard/settings/whatsapp",
    detectName: "hasReminderChannel",
  },
  {
    key: "widget_qr_setup",
    order: 4,
    group: OnboardingGroup.checklist_optional,
    titleI18nKey: "onboarding.widget_qr_setup.title",
    descI18nKey: "onboarding.widget_qr_setup.desc",
    // Compartir has the link, the QR and the widget code (O10).
    href: "/dashboard/compartir",
    detectName: "hasWidgetOrQr",
  },
  {
    key: "whatsapp_business",
    order: 8,
    group: OnboardingGroup.checklist_optional,
    titleI18nKey: "onboarding.whatsapp_business.title",
    descI18nKey: "onboarding.whatsapp_business.desc",
    href: "/dashboard/settings/whatsapp",
    detectName: "hasWhatsAppConnection",
  },
];

/**
 * Steps taken out of the checklist. Their rows stay (states point at them by
 * key) but are disabled, so getState and the checklist no longer list or
 * count them.
 *
 * payment_method ("Conecta los pagos"): there is no online payment for
 * salons yet (the Stripe settings page redirects, #239), and its detector
 * read the salon's KiraRoom subscription customer, not a payment account.
 */
export const RETIRED_STEP_KEYS: readonly string[] = ["payment_method"];

@Injectable()
export class OnboardingStepSeeder implements OnModuleInit {
  private readonly logger = new Logger(OnboardingStepSeeder.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      for (const def of DEFAULT_STEP_DEFS) {
        await this.prisma.onboardingStepDef.upsert({
          where: { key: def.key },
          create: def,
          update: {
            order: def.order,
            group: def.group,
            titleI18nKey: def.titleI18nKey,
            descI18nKey: def.descI18nKey,
            href: def.href,
            detectName: def.detectName,
          },
        });
      }
      await this.prisma.onboardingStepDef.updateMany({
        where: { key: { in: [...RETIRED_STEP_KEYS] }, enabled: true },
        data: { enabled: false },
      });
      this.logger.log(`Seeded ${DEFAULT_STEP_DEFS.length} onboarding step defs`);
    } catch (err) {
      this.logger.warn(
        `OnboardingStepSeeder skipped (likely no DB yet): ${(err as Error).message}`,
      );
    }
  }
}