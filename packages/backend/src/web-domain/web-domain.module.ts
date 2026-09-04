import { Module } from "@nestjs/common";
import { WebDomainController } from "./web-domain.controller";
import { WebDomainService } from "./web-domain.service";

@Module({
  controllers: [WebDomainController],
  providers: [WebDomainService],
  exports: [WebDomainService],
})
export class WebDomainModule {}