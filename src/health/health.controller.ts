import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DbHealthIndicator, RedisHealthIndicator } from './indicators';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: DbHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * Liveness — deliberately dependency-free. A DB/Redis blip must NOT make
   * the orchestrator kill an otherwise-healthy process; that's readiness.
   */
  @Get()
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Readiness — pings Postgres + Redis; 503 when a dependency is down. */
  @Get('ready')
  @HealthCheck()
  @ApiExcludeEndpoint()
  ready() {
    return this.health.check([
      () => this.db.isHealthy('database'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
