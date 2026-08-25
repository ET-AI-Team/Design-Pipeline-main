import type { WorkerOptions } from 'bullmq';
import { redisConnection } from './queue-definitions';

/**
 * Shared worker options implementing LLD §4.4's stalled-job table.
 * A worker that dies mid-call leaves its job locked for lockDuration;
 * after that, BullMQ's stalled-check makes it available again. This is
 * treated as a technical failure, not a content-quality retry.
 */
// Typed as the full WorkerOptions, not Partial - this gets passed
// directly into `new Worker()`, which requires `connection` to be
// definitely present, not possibly undefined. It always is here; the
// readme's original `Partial<>` typing was never actually caught
// because no real Worker was ever built to pass it into.
export const stalledJobWorkerOptions: WorkerOptions = {
  connection: redisConnection,
  // Real bug found live: LLD §4.4 specified 30s, but real base_asset/
  // poster generation calls routinely take 40-90s+ (observed up to 286s
  // in this session's own logs) - BullMQ was reprocessing a job that was
  // still legitimately running, producing a real duplicate paid API call
  // plus a db.stageAttempt.create() unique-constraint failure on the
  // second write. Raised well past every observed real latency, with
  // margin - deviates from the documented LLD value on purpose.
  lockDuration: 300_000, // 5 minutes
  stalledInterval: 30_000, // checked every 30s
  maxStalledCount: 2, // after 2 recoveries, treated as a permanent technical failure
};
