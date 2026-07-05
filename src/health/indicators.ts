import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { RedisService } from '../db/redis.service';

const PROBE_TIMEOUT_MS = 2000;

/**
 * Races a probe against a timeout so a hung (not errored) dependency — a
 * black-holed connection or a saturated pool — still resolves the readiness
 * check to `down()` instead of blocking the endpoint indefinitely.
 */
function withTimeout<T>(probe: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    probe,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} probe timed out`)), PROBE_TIMEOUT_MS).unref(),
    ),
  ]);
}

@Injectable()
export class DbHealthIndicator {
  constructor(
    private readonly database: DatabaseService,
    private readonly healthIndicator: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicator.check(key);
    try {
      await withTimeout(this.database.db.execute(sql`SELECT 1`), 'database');
      return indicator.up();
    } catch (err) {
      return indicator.down({
        message: err instanceof Error ? err.message : 'database unreachable',
      });
    }
  }
}

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly redis: RedisService,
    private readonly healthIndicator: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicator.check(key);
    try {
      const pong = await withTimeout<string>(this.redis.ping(), 'redis');
      if (pong !== 'PONG') throw new Error(`unexpected ping reply: ${pong}`);
      return indicator.up();
    } catch (err) {
      return indicator.down({ message: err instanceof Error ? err.message : 'redis unreachable' });
    }
  }
}
