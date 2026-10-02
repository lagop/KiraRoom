import { Module } from "@nestjs/common";
import { PublicTenantController } from "./tenant.controller";
import { PrismaModule } from "../common/prisma/prisma.module";
import { PublicSiteService } from "./public-site.service";
import { WebDomainModule } from "../web-domain/web-domain.module";

@Module({
  imports: [PrismaModule, WebDomainModule],
  controllers: [PublicTenantController],
  providers: [PublicSiteService],
})
export class PublicModule {}
