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
import { ReadOnlyNoticeService } from "./read-only-notice.service";
import { NotificationsModule } from "../notifications/notifications.module";
import { ProfessionalsModule } from "../professionals/professionals.module";
import { LoyaltyModule } from "../loyalty/loyalty.module";
import { PlatformModule } from "../platform/platform.module";
import { GiftCardsModule } from "../gift-cards/gift-cards.module";

@Module({
  imports: [
    PrismaModule,
    ProfessionalsModule,
    // Payments and refunds move loyalty points (PaymentsService.loyaltyAfter).
    LoyaltyModule,
    // A refund of a gift card payment goes back to the card (PaymentsService.refundPayment).
    GiftCardsModule,
    NotificationsModule,
    forwardRef(() => MessageBundlesModule),
    ScheduleModule.forRoot(),
    // KiraRoom's Stripe account, set in the platform console (else .env).
    PlatformModule,
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
    ReadOnlyNoticeService,
  ],
  exports: [
    PaymentsService,
    StripeService,
    WalletService,
    SubscriptionsService,
    AddOnsService,
    // AppModule also mounts PaymentsController, which needs it.
    ReadOnlyNoticeService,
  ],
})
export class PaymentsModule {}
