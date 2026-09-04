import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { CommonModule } from "../../common/common.module";
import { NotificationsModule } from "../../notifications/notifications.module";
import { SaasModule } from "../saas.module";
import {
  PublicInvitesController,
  SaasInvitesController,
} from "./invites.controller";
import { InvitesService } from "./invites.service";

/**
 * Module for Sprint 2 / Workstream 2.1 (self-serve onboarding).
 *
 * Exports `InvitesService` so `SaasController.getTenantProgress` and
 * the audit-log path can reuse the service. Imports `SaasModule` for
 * `AuditLogService` and `NotificationsModule` for `EmailService`.
 */
@Module({
  imports: [
    CommonModule,
    NotificationsModule,
    SaasModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>("JWT_SECRET"),
      }),
    }),
  ],
  controllers: [PublicInvitesController, SaasInvitesController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}