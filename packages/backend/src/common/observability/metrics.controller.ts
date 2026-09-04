import { Controller, Get, Header, Res } from "@nestjs/common";
import { Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Prometheus-style text exposition. Mounted at `/internal/metrics`
 * (no auth — assume the deployment keeps /internal behind an
 * internal-only load balancer / network policy).
 */
@Controller('internal/metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(@Res() res: Response): void {
    res.send(this.metrics.render());
  }
}
