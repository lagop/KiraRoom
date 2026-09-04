import { Module } from "@nestjs/common";
import { PublicTenantController } from "./tenant.controller";
import { PrismaModule } from "../common/prisma/prisma.module";

@Module({
  imports: [PrismaModule],
  controllers: [PublicTenantController],
})
export class PublicModule {}
