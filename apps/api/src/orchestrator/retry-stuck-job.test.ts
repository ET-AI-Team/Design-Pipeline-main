import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { createServer } from 'node:http';
import { db } from '../lib/db';
import { retryStuckJob } from './retry-stuck-job';
import { registerStage, unregisterStageForTest } from './stage-registry';
import { attachSocketServer } from '../realtime/socket-server';

registerStage({
  name: 'retry_test_stage',
  queue: 'image-generation',
  nextStageOnPass: undefined,
  buildPrompt: () => 'retry test prompt',
  getInputAssetUrl: () => undefined,
});

// Same shape as poster.stage.ts/logo-composite.stage.ts's registration -
// `queue` is unused for a deterministic stage, kept only for type
// completeness.
registerStage({
  name: 'retry_test_deterministic_stage',
  queue: 'image-generation',
  nextStageOnPass: undefined,
  isDeterministic: true,
  buildPrompt: () => '',
  getInputAssetUrl: () => undefined,
});

describe('retryStuckJob', () => {
  let jobId: string;
  let httpServer: ReturnType<typeof createServer>;

  beforeAll(() => {
    // emitStatusChanged() needs a real attached Socket.IO server - see
    // the same fix in handle-stage-result.test.ts for why.
    httpServer = createServer();
    attachSocketServer(httpServer);
  });

  afterAll(() => {
    httpServer.close();
    // Take the fake stage back out of the process-global registry.
    // Without this it leaks into every other test file sharing the
    // process, and stages/index.test.ts - which asserts the registry's
    // EXACT contents - fails depending on file order.
    unregisterStageForTest('retry_test_stage');
    unregisterStageForTest('retry_test_deterministic_stage');
  });

  afterEach(async () => {
    if (jobId) {
      await db.stageAttempt.deleteMany({ where: { jobId } });
      await db.job.delete({ where: { id: jobId } }).catch(() => {});
    }
  });

  it(
    'resets a NEEDS_ATTENTION job and re-dispatches its stuck stage',
    async () => {
      const job = await db.job.create({
        data: {
          reference1Url: 'https://example.com/r1.png',
          reference2Url: 'https://example.com/r2.png',
          logoUrl: 'https://example.com/logo.png',
          prompt: 'retry stuck job test, ten-plus characters',
          status: 'NEEDS_ATTENTION',
        },
      });
      jobId = job.id;

      // A real escalated job always has all 3 attempt rows, not just the
      // final one - the original version of this test only created
      // attempt 3, which meant attempt 1 was never actually taken and
      // couldn't expose the real bug: dispatchStageJob's idempotent
      // insert at attemptNumber 1 silently no-ops when that row already
      // exists, so retrying a real stuck job never re-dispatched
      // anything even though Job.status flipped to QUEUED. Confirmed by
      // actually clicking Retry on a real escalated job in the browser.
      for (const attemptNumber of [1, 2, 3] as const) {
        await db.stageAttempt.create({
          data: {
            jobId, stage: 'retry_test_stage', attemptNumber, modelUsed: 'test',
            latencyMs: 100, costInr: 1,
            result: attemptNumber < 3 ? 'RETRY' : 'ESCALATED',
            startedAt: new Date(), completedAt: new Date(),
          },
        });
      }

      const result = await retryStuckJob(jobId);
      expect(result.status).toBe('QUEUED');

      // The real assertion: a fresh attempt 1 row must exist afterward,
      // proving dispatchStageJob's insert actually went through rather
      // than being silently swallowed by the unique constraint.
      const attempts = await db.stageAttempt.findMany({ where: { jobId, stage: 'retry_test_stage' } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.attemptNumber).toBe(1);
      expect(attempts[0]?.result).not.toBe('ESCALATED');
    },
    15_000
  );

  it(
    'routes a stuck DETERMINISTIC stage inline instead of onto a queue - real bug found live: dispatchStageJob() always enqueues onto BullMQ, but poster/logo_composite are deterministic and never processed by a worker at all - the worker throws immediately on one ("should never be queued"), which technical-failure-escalates the job straight back to NEEDS_ATTENTION without the stage ever actually re-running',
    async () => {
      const job = await db.job.create({
        data: {
          reference1Url: 'https://example.com/r1.png',
          reference2Url: 'https://example.com/r2.png',
          logoUrl: 'https://example.com/logo.png',
          prompt: 'deterministic retry stuck job test, ten-plus characters',
          status: 'NEEDS_ATTENTION',
        },
      });
      jobId = job.id;

      for (const attemptNumber of [1, 2] as const) {
        await db.stageAttempt.create({
          data: {
            jobId, stage: 'retry_test_deterministic_stage', attemptNumber, modelUsed: 'test',
            latencyMs: 100, costInr: 1,
            result: attemptNumber < 2 ? 'RETRY' : 'ESCALATED',
            startedAt: new Date(), completedAt: new Date(),
          },
        });
      }

      const result = await retryStuckJob(jobId);
      expect(result.status).toBe('QUEUED');

      // The real assertion: no fresh attempt row via the queue-dispatch
      // path (dispatchStageJob's own idempotent placeholder insert) -
      // a deterministic stage must never go through dispatchStageJob at
      // all. run-deterministic-stage.ts's runDeterministicStage() only
      // writes a row for its two real stage names ('poster'/
      // 'logo_composite'); for this synthetic test stage it throws
      // before writing anything - zero rows here is exactly the signal
      // that retryStuckJob correctly routed inline instead of onto the
      // queue (the old, buggy code would have created attempt 1 via
      // dispatchStageJob's placeholder insert).
      const attempts = await db.stageAttempt.findMany({ where: { jobId, stage: 'retry_test_deterministic_stage' } });
      expect(attempts).toHaveLength(0);
    },
    15_000
  );

  it(
    'throws INVALID_STATE_TRANSITION for a job not in a retryable state',
    async () => {
      const job = await db.job.create({
        data: {
          reference1Url: 'https://example.com/r1.png',
          reference2Url: 'https://example.com/r2.png',
          logoUrl: 'https://example.com/logo.png',
          prompt: 'not retryable test job, ten-plus chars',
          status: 'POSTER_GENERATING',
        },
      });
      jobId = job.id;

      await expect(retryStuckJob(jobId)).rejects.toThrow('Job is not in a retryable state');
    },
    15_000
  );
});
