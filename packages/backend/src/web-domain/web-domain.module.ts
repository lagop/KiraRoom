import { Module } from "@nestjs/common";
import { WebDomainController } from "./web-domain.controller";
import { TraefikProviderController } from "./traefik-provider.controller";
import { WebDomainService } from "./web-domain.service";
import { DnsLookup } from "./custom-domain";

@Module({
  controllers: [WebDomainController, TraefikProviderController],
  providers: [WebDomainService, DnsLookup],
  exports: [WebDomainService],
})
export class WebDomainModule {}
