import { Module } from "@nestjs/common";
import { WebDomainController } from "./web-domain.controller";
import { WebDomainService } from "./web-domain.service";
import { DnsLookup } from "./custom-domain";

@Module({
  controllers: [WebDomainController],
  providers: [WebDomainService, DnsLookup],
  exports: [WebDomainService],
})
export class WebDomainModule {}
