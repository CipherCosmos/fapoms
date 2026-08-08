import { Controller, Get, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint.
 *
 * Unauthenticated by design (no controller-level guards) so a scraper without a
 * token can read it, exactly like the health checks. It exposes only aggregate
 * operational metrics — no business data — but it should still be reachable only
 * from the internal network / scrape subnet at the infrastructure layer.
 */
@ApiTags('Observability')
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @ApiOperation({ summary: 'Prometheus metrics exposition' })
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.scrape());
  }
}
