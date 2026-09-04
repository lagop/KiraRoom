import { Module } from "@nestjs/common";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { GdprController } from "./gdpr.controller";
import { GdprService } from "./gdpr.service";

@Module({
  imports: [PrismaModule],
  controllers: [GdprController],
  providers: [GdprService],
  exports: [GdprService],
})
export class GdprModule {}
