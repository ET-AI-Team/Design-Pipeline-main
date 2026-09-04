import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { db } from '../lib/db';
import { registerStage, unregisterStageForTest } from '../orchestrator/stage-registry';
import { dispatchStageJob } from '../queues/dispatch';
import type { StageResult } from '../orchestrator/types';
// Side-effect import: starts the real Worker instances, exactly as
// server.ts will. This is the actual thing under test - that a
// dispatched job gets picked up and processed end to end, not just
// that the pieces individually compile.
import '../workers/pipeline-worker';

const TEST_STAGE = 'worker_test_stage';

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 10_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('pipeline worker end-to-end', () => {
  let jobId: string;
  let executeCallCount = 0;

  beforeAll(async () => {
    registerStage({
      name: TEST_STAGE,
      queue: 'image-generation',
      nextStageOnPass: undefined,
      buildPrompt: () => 'worker test prompt',
      getInputAssetUrl: () => undefined,
      execute: async (): Promise<StageResult> => {
        executeCallCount += 1;
        return {
          assetUrl: 'https://example.com/worker-test-output.png',
          qaScore: 9,
          qaReasoning: 'fake pass, no real provider call',
          modelUsed: 'fake-model',
          latencyMs: 1,
          costInr: 0,
        };
      },
    });

    const job = await db.job.create({
      data: {
        reference1Url: 'https://example.com/r1.png',
        reference2Url: 'https://example.com/r2.png',
        logoUrl: 'https://example.com/logo.png',
        prompt: 'worker end-to-end test job, ten-plus chars',
      },
    });
    jobId = job.id;
  });

  afterAll(async () => {
    await db.stageAttempt.deleteMany({ where: { jobId } });
    await db.job.delete({ where: { id: jobId } });
    // Take the fake stage back out of the process-global registry.
    // Without this it leaks into every other test file sharing the
    // process, and stages/index.test.ts - which asserts the registry's
    // EXACT contents - fails depending on file order.
    unregisterStageForTest(TEST_STAGE);
  });

  it(
    'dispatching a job through BullMQ actually runs execute() and updates the StageAttempt to PASS',
    async () => {
      await dispatchStageJob({ jobId, stage: TEST_STAGE, attemptNumber: 1, prompt: 'test' });

      const attempt = await waitFor(async () => {
        const row = await db.stageAttempt.findUnique({
          where: { jobId_stage_attemptNumber: { jobId, stage: TEST_STAGE, attemptNumber: 1 } },
        });
        return row?.result === 'PASS' ? row : null;
      });

      expect(attempt.result).toBe('PASS');
      expect(attempt.modelUsed).toBe('fake-model');
      expect(Number(attempt.qaScore)).toBe(9);
      expect(executeCallCount).toBe(1);
    },
    15_000
  );
});
