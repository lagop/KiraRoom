import {
  Controller,
  Get,
  Header,
  Logger,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { Public } from "../../auth/decorators/public.decorator";
import { MetricsService } from "./metrics.service";

/**
 * Prometheus text exposition at `/internal/metrics`.
 *
 * This used to carry a comment saying "no auth -- assume the deployment
 * keeps /internal behind an internal-only load balancer", while actually
 * sitting on the same public router as everything else. Two consequences:
 * any authenticated tenant user could read platform-wide counters, and
 * Prometheus could not scrape it at all, because the global JWT guard
 * answered 401 to a scraper that has no user.
 *
 * So it is now explicitly public, and authenticated by a scrape token
 * instead: the thing reading it is a machine, not a person. Without
 * `METRICS_SCRAPE_TOKEN` configured it refuses in production rather than
 * exposing the endpoint, and stays open in development so `curl` works.
 */
@Controller("internal/metrics")
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Public()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  render(@Req() req: Request, @Res() res: Response): void {
    const expected = this.config.get<string>("METRICS_SCRAPE_TOKEN");

    if (!expected) {
      if (process.env.NODE_ENV === "production") {
        this.logger.error(
          "Metrics scrape refused: METRICS_SCRAPE_TOKEN is not configured.",
        );
        throw new UnauthorizedException("Metrics endpoint not configured");
      }
      res.send(this.metrics.render());
      return;
    }

    const header = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const given = Buffer.from(header);
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new UnauthorizedException("Invalid scrape token");
    }

    res.send(this.metrics.render());
  }
}
