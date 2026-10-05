import { Controller, Get, Logger, NotFoundException, Query, Req, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiExcludeController } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { timingSafeEqual } from "crypto";
import type { Request } from "express";
import { Public } from "../auth/decorators/public.decorator";
import { WebDomainService } from "./web-domain.service";

/**
 * GET /internal/traefik/dynamic -- what Traefik's HTTP provider polls to
 * learn the salons' hosts and get their certificates (traefik-provider.ts).
 *
 * Public because Traefik has no user; authenticated by TRAEFIK_PROVIDER_TOKEN,
 * as "Authorization: Bearer <token>" or "?token=<token>" (older Traefik
 * versions cannot send headers from the HTTP provider). Without the token
 * configured it answers 404: the list of salons' domains is not for anyone.
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller("internal/traefik")
export class TraefikProviderController {
  private readonly logger = new Logger(TraefikProviderController.name);

  constructor(
    private readonly webDomain: WebDomainService,
    private readonly config: ConfigService,
  ) {}

  @Get("dynamic")
  async dynamic(@Req() req: Request, @Query("token") queryToken?: string) {
    const expected = (this.config.get<string>("TRAEFIK_PROVIDER_TOKEN") ?? "").trim();
    if (!expected) throw new NotFoundException();
    const header = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const given = Buffer.from(header || queryToken || "");
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      this.logger.warn("Traefik provider request with a wrong token");
      throw new UnauthorizedException();
    }
    return this.webDomain.traefikConfig();
  }
}
