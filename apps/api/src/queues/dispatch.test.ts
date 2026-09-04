import { describe, it, expect, afterAll, beforeAll } from 'bun:test';
import { db } from '../lib/db';
import { dispatchStageJob } from './dispatch';
import { registerStage, unregisterStageForTest } from '../orchestrator/stage-registry';

// The readme's original test dispatched a stage named 'base_asset'
// without ever registering it - dispatchStageJob() calls
// getStageDefinition() after creating the StageAttempt row, which would
// throw "No stage registered" since real stage registration doesn't
// happen until Phase 6. A distinctly-named dummy stage (not 'base_asset',
// to avoid colliding with the real one once Phase 6 registers it in the
// same test process) is registered here instead, matching the pattern
// Phase 5.3's own test already uses for exactly this reason.
const DUMMY_STAGE = 'dispatch_test_stage';

describe('dispatchStageJob idempotency', () => {
  let jobId: string;

  beforeAll(() => {
    registerStage({
      name: DUMMY_STAGE,
      queue: 'image-generation',
      nextStageOnPass: undefined,
      buildPrompt: () => 'test prompt',
      getInputAssetUrl: () => undefined,
    });
  });

  beforeAll(async () => {
    const job = await db.job.create({
      data: {
        reference1Url: 'https://example.com/r1.png',
        reference2Url: 'https://example.com/r2.png',
        logoUrl: 'https://example.com/logo.png',
        prompt: 'idempotency test job, ten-plus characters',
      },
    });
    jobId = job.id;
  });

  it('rejects a duplicate dispatch of the same attempt silently', async () => {
    const payload = { jobId, stage: DUMMY_STAGE, attemptNumber: 1, prompt: 'test' };

    await dispatchStageJob(payload);
    const countAfterFirst = await db.stageAttempt.count({ where: { jobId, stage: DUMMY_STAGE } });
    expect(countAfterFirst).toBe(1);

    // Second call with identical (jobId, stage, attemptNumber) must not create a second row.
    await dispatchStageJob(payload);
    const countAfterSecond = await db.stageAttempt.count({ where: { jobId, stage: DUMMY_STAGE } });
    expect(countAfterSecond).toBe(1);
  });

  afterAll(async () => {
    await db.stageAttempt.deleteMany({ where: { jobId } });
    await db.job.delete({ where: { id: jobId } });
    // Take the fake stage back out of the process-global registry.
    // Without this it leaks into every other test file sharing the
    // process, and stages/index.test.ts - which asserts the registry's
    // EXACT contents - fails depending on file order.
    unregisterStageForTest(DUMMY_STAGE);
    // Deliberately NOT closing imageGenerationQueue/redisConnection/db here
    // (the readme's original test did) - these are process-wide singletons
    // from queue-definitions.ts and db.ts, shared by every other test file.
    // Bun runs all matched files in one process, so closing them here
    // poisoned every later test file's queue dispatches and DB access -
    // confirmed by reproducing "Connection is closed" errors in other
    // files when the full suite ran together. Let the process exit close
    // these naturally instead of tearing down shared infra per-file.
  });
});
