import { forwardRef, Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { PaymentsController } from "./payments.controller";
import { WebhooksController } from "./webhooks.controller";
import { AddOnsAdminController } from "./controllers/addons.controller";
import { TenantAddOnsController } from "./controllers/tenant-addons.controller";
import { PaymentsService } from "./payments.service";
import { PrismaModule } from "../common/prisma/prisma.module";
import { StripeService } from "./services/stripe.service";
import { WalletService } from "./services/wallet.service";
import { SubscriptionsService } from "./services/subscriptions.service";
import { AddOnsService } from "./services/addons.service";
import { MessageBundlesModule } from "../message-bundles/message-bundles.module";
import { BillingScheduler } from "./billing.scheduler";
import { TrialExpiryScheduler } from "./trial-expiry.scheduler";
import { GracePeriodScheduler } from "./grace-period.scheduler";
import { NotificationsModule } from "../notifications/notifications.module";
import { ProfessionalsModule } from "../professionals/professionals.module";

@Module({
  imports: [
    PrismaModule,
    ProfessionalsModule,
    NotificationsModule,
    forwardRef(() => MessageBundlesModule),
    ScheduleModule.forRoot(),
  ],
  controllers: [PaymentsController, WebhooksController, AddOnsAdminController, TenantAddOnsController],
  providers: [
    PaymentsService,
    StripeService,
    WalletService,
    SubscriptionsService,
    AddOnsService,
    BillingScheduler,
    TrialExpiryScheduler,
    GracePeriodScheduler,
  ],
  exports: [
    PaymentsService,
    StripeService,
    WalletService,
    SubscriptionsService,
    AddOnsService,
  ],
})
export class PaymentsModule {}
