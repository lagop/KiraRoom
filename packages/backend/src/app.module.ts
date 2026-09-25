import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./common/prisma/prisma.module";
import { TenancyModule } from "./common/tenancy/tenancy.module";
import { TelemetryModule } from "./common/telemetry/telemetry.module";
import { RedisModule } from "./common/cache/redis.module";
import { FeatureFlagModule } from "./common/feature-flags/feature-flag.module";
import { CommonModule } from "./common/common.module";
import { ObservabilityModule } from "./common/observability/observability.module";
import { AdminModule } from "./admin/admin.module";
import { NotificationsModule } from "./notifications/notifications.module";
import { VirtualReceptionistModule } from "./virtual-receptionist/virtual-receptionist.module";
import { PlatformModule } from "./platform/platform.module";
import { AssistantModule } from "./assistant/assistant.module";
import { WaitListModule } from "./wait-list/wait-list.module";
import { UpsellModule } from "./upsell/upsell.module";
import { MessageBundlesModule } from "./message-bundles/message-bundles.module";
import { ProfessionalsModule } from "./professionals/professionals.module";
import { PaymentsModule } from "./payments/payments.module";
import { PosModule } from "./pos/pos.module";
import { CommissionsModule } from "./commissions/commissions.module";
import { LoyaltyModule } from "./loyalty/loyalty.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { PromotionsModule } from "./promotions/promotions.module";
import { EmailCampaignsModule } from "./email-campaigns/email-campaigns.module";
import { SocialIntegrationsModule } from "./social-integrations/social-integrations.module";
import { AppointmentsModule } from "./appointments/appointments.module";
import { SaasModule } from "./saas/saas.module";
import { AuditLogService } from "./saas/audit-log.service";
import { MultiLocationModule } from "./multi-location/multi-location.module";
import { WebDomainModule } from "./web-domain/web-domain.module";
import { WidgetModule } from "./widget/widget.module";
import { QrModule } from "./qr/qr.module";
import { ImportModule } from "./import/import.module";
import { IcsFeedsModule } from "./ics-feeds/ics-feeds.module";
import { ConsentModule } from "./consent/consent.module";
import { ReviewsModule } from "./reviews/reviews.module";
import { WhatsAppModule } from "./whatsapp/whatsapp.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { RebookingModule } from "./rebooking/rebooking.module";
import { InvoicesModule } from "./invoices/invoices.module";
import { AccountingModule } from "./accounting/accounting.module";
import { GiftCardsModule } from "./gift-cards/gift-cards.module";
import { ExportsModule } from "./exports/exports.module";
import { SmsModule } from "./sms/sms.module";

// Controllers
import { AppController } from "./app.controller";
import { AuthController } from "./auth/auth.controller";
import { AppointmentsController } from "./appointments/appointments.controller";
import { AppointmentServicesController } from "./appointments/appointment-services.controller";
import { ClientsController } from "./clients/clients.controller";
import { ServicesController } from "./services/services.controller";
import { SalonController } from "./salon/salon.controller";
import { PaymentsController } from "./payments/payments.controller";

// Services
import { AppService } from "./app.service";
import { AuthService } from "./auth/auth.service";
import { AppointmentServicesService } from "./appointments/appointment-services.service";
import { ClientsService } from "./clients/clients.service";
import { ServicesService } from "./services/services.service";
import { SalonService } from "./salon/salon.service";

// Guards
import { ThrottlerBehindProxyGuard } from "./common/guards/throttler-behind-proxy.guard";
import { JwtStrategy } from "./auth/strategies/jwt.strategy";
import { JwtAuthGuard } from "./auth/guards/jwt-auth.guard";
import { BugReportModule } from "./bug-reports/bug-report.module";
import { InvitesModule } from "./saas/invites/invites.module";
import { PublicModule } from "./public-site/public.module";

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),

    // Passport
    PassportModule.register({ defaultStrategy: "jwt" }),

    // Per-request tenant context, consumed by the Prisma tenant-scope
    // extension. Must be registered so its middleware wraps every route.
    TenancyModule,

    // Activation-funnel telemetry (global provider).
    TelemetryModule,

    // Observability â€” correlation id middleware (paired with pino logger).
    ObservabilityModule,

    // JWT
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>("JWT_SECRET"),
        signOptions: {
          expiresIn:
            parseInt(configService.get<string>("JWT_EXPIRES_IN") || "15") * 60,
        },
      }),
      inject: [ConfigService],
    }),

    // Prisma Database
    PrismaModule,

    // Common shared services (EncryptionService + HMAC helpers)
    CommonModule,

    // Redis-backed cache (RedisService is @Global() so any feature
    // module can inject it without re-importing). If the connection
    // fails the service degrades to an in-memory fallback transparently.
    RedisModule,

    // Plan / feature gating (global â€“ must come before feature-using modules)
    FeatureFlagModule,

    // Rate limiting
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),

    // Admin module
    AdminModule,

    // Notifications module
    NotificationsModule,

    // Virtual Receptionist module
    VirtualReceptionistModule,
    PlatformModule,
    AssistantModule,
    // P2A-receptionist-advanced -- virtual wait-list and service upsell.
    WaitListModule,
    UpsellModule,
    // P2A-receptionist-v2 -- metered WhatsApp marketing + SMS via
    // pre-paid message bundles.
    MessageBundlesModule,
    // Professionals module
    ProfessionalsModule,

    // Payments module
    PaymentsModule,

    // POS module
    PosModule,

    // Commissions module
    CommissionsModule,

    // Loyalty module
    LoyaltyModule,

    // Analytics module
    AnalyticsModule,

    // Promotions module
    PromotionsModule,

    // Email Campaigns module
    EmailCampaignsModule,

    // Social Integrations module
    SocialIntegrationsModule,

    // Appointments module
    AppointmentsModule,

    // SaaS Owner module
    SaasModule,

    // Multi-location (plan Empresa)
    MultiLocationModule,

    // Add-on web_domain
    WebDomainModule,

    // P0 â€” Widget / QR / Import / Consent / Reviews / WhatsApp
    WidgetModule,
    QrModule,
    ImportModule,
    IcsFeedsModule,
    ConsentModule,
    ReviewsModule,
    WhatsAppModule,

    // P1 â€” Onboarding wizard + Rebooking
    OnboardingModule,
    RebookingModule,

    // P2A â€” Fiscal EspaÃ±a (Verifactu / TicketBAI / SII)
    InvoicesModule,

    // P2B â€” Accounting integrations (Holded / Sage)
    AccountingModule,

    // Gift cards (plan-gated feature, controller @Feature('gift_cards'))
    GiftCardsModule,

    // Exports (CSV + XLSX); no FeatureGuard so they stay reachable in cancelled/archived
    ExportsModule,

    // SMS controller (gated by @Feature('sms_notifications'))
    SmsModule,

    // Zero-budget launch â€” bug reports endpoint
    BugReportModule,

    // Sprint 2 / Workstream 2.1 â€” self-serve tenant onboarding
    // (invite flow + accept-invite wizard + trial state machine)
    InvitesModule,

    // Public site resolution — `/public-site/tenant/:slug` (no auth, path-bypass)
    PublicModule,
  ],
  controllers: [
    AppController,
    AuthController,
    AppointmentsController,
    AppointmentServicesController,
    ClientsController,
    ServicesController,
    SalonController,
    PaymentsController,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerBehindProxyGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    AppService,
    AuthService,
    AuditLogService,
    ClientsService,
    AppointmentServicesService,
    ServicesService,
    SalonService,
    JwtStrategy,
  ],
})
export class AppModule {}





