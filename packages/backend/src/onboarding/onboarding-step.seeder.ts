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
    key: "payment_method",
    order: 4,
    group: OnboardingGroup.checklist_optional,
    titleI18nKey: "onboarding.payment_method.title",
    descI18nKey: "onboarding.payment_method.desc",
    href: "/dashboard/settings/stripe",
    detectName: "hasStripeCustomer",
  },
  {
    key: "branding",
    order: 5,
    group: OnboardingGroup.checklist_optional,
    titleI18nKey: "onboarding.branding.title",
    descI18nKey: "onboarding.branding.desc",
    href: "/dashboard/settings/salon#branding",
    detectName: "hasCoverImageAndDescription",
  },
  {
    key: "reminders_enabled",
    order: 6,
    group: OnboardingGroup.checklist_optional,
    titleI18nKey: "onboarding.reminders_enabled.title",
    descI18nKey: "onboarding.reminders_enabled.desc",
    href: "/dashboard/notifications",
    detectName: "hasActiveReminderTemplate",
  },
  {
    key: "widget_qr_setup",
    order: 7,
    group: OnboardingGroup.checklist_optional,
    titleI18nKey: "onboarding.widget_qr_setup.title",
    descI18nKey: "onboarding.widget_qr_setup.desc",
    href: "/dashboard/settings/widget",
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
      this.logger.log(`Seeded ${DEFAULT_STEP_DEFS.length} onboarding step defs`);
    } catch (err) {
      this.logger.warn(
        `OnboardingStepSeeder skipped (likely no DB yet): ${(err as Error).message}`,
      );
    }
  }
}