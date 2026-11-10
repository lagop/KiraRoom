import { Module } from "@nestjs/common";
import { PublicTenantController } from "./tenant.controller";
import { PrismaModule } from "../common/prisma/prisma.module";
import { PublicSiteService } from "./public-site.service";
import { WebDomainModule } from "../web-domain/web-domain.module";
import { PlatformModule } from "../platform/platform.module";

@Module({
  // PlatformModule: whether the salon can take online payments.
  imports: [PrismaModule, WebDomainModule, PlatformModule],
  controllers: [PublicTenantController],
  providers: [PublicSiteService],
})
export class PublicModule {}
