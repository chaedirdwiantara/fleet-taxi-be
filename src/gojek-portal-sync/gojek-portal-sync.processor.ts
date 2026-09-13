import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { Env } from '../config/env';
import { GojekPortalSyncService } from './gojek-portal-sync.service';
import {
  GOJEK_PORTAL_SYNC_QUEUE,
  GOJEK_PORTAL_SYNC_TICK_EVERY_MS,
  GOJEK_PORTAL_SYNC_TICK_ID,
  SyncRunJobData,
} from './gojek-portal-sync.types';

/**
 * Worker for the portal sync queue. Two job kinds:
 *  - `tick`: the repeatable 30-minute heartbeat; the service decides whether
 *    the daily run is due (schedule time passed, not yet successful today,
 *    under the retry cap) and executes it inline.
 *  - `run`: a "Jalankan sekarang" request for an already-recorded run.
 * Concurrency stays at 1 so two pulls never overlap.
 */
@Processor(GOJEK_PORTAL_SYNC_QUEUE)
export class GojekPortalSyncProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(GojekPortalSyncProcessor.name);

  constructor(
    private readonly service: GojekPortalSyncService,
    @InjectQueue(GOJEK_PORTAL_SYNC_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService<Env, true>,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    // Test apps boot dozens of times against one Redis; the tick is exercised
    // directly through the service there.
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') return;
    await this.queue.upsertJobScheduler(
      GOJEK_PORTAL_SYNC_TICK_ID,
      { every: GOJEK_PORTAL_SYNC_TICK_EVERY_MS },
      { name: 'tick', opts: { removeOnComplete: 20, removeOnFail: 50 } },
    );
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case 'tick': {
        const decision = await this.service.runScheduledTick();
        this.logger.log(`tick: ${decision.due ? 'run' : 'skip'} — ${decision.reason}`);
        return;
      }
      case 'run':
        return this.service.execute((job.data as SyncRunJobData).runId);
      default:
        this.logger.warn(`Unknown job: ${job.name}`);
    }
  }
}
