import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { createServer } from 'node:http';
import { db } from '../lib/db';
import { handleStageResult, escalateTechnicalFailure } from './handle-stage-result';
import { registerStage } from './stage-registry';
import { attachSocketServer } from '../realtime/socket-server';
import type { StageResult } from './types';

describe('handleStageResult', () => {
  let jobId: string;
  let httpServer: ReturnType<typeof createServer>;

  beforeAll(() => {
    // Register a minimal test stage so this suite does not depend on
    // the real pipeline stages from Phase 6.
    registerStage({
      name: 'hsr_test_stage',
      queue: 'image-generation',
      buildPrompt: () => 'test prompt',
      getInputAssetUrl: () => undefined,
      nextStageOnPass: undefined,
    });

    // The escalation path calls emitNeedsAttention(), which needs a real
    // attached Socket.IO server - the readme's own version of this test
    // never attached one, which would throw. Not listening on a port
    // since nothing needs to connect to it for this suite's purposes.
    httpServer = createServer();
    attachSocketServer(httpServer);
  });

  afterAll(() => {
    httpServer.close();
  });

  beforeEach(async () => {
    const job = await db.job.create({
      data: {
        reference1Url: 'https://example.com/r1.png',
        reference2Url: 'https://example.com/r2.png',
        logoUrl: 'https://example.com/logo.png',
        prompt: 'orchestrator test job, ten-plus characters',
      },
    });
    jobId = job.id;
    await db.stageAttempt.create({
      data: {
        jobId,
        stage: 'hsr_test_stage',
        attemptNumber: 1,
        modelUsed: '',
        latencyMs: 0,
        costInr: 0,
        result: 'RETRY',
        startedAt: new Date(),
      },
    });
  });

  afterEach(async () => {
    await db.stageAttempt.deleteMany({ where: { jobId } });
    await db.job.delete({ where: { id: jobId } });
  });

  const passResult: StageResult = {
    assetUrl: 'https://example.com/out.png',
    qaScore: 9,
    qaReasoning: 'looks good',
    modelUsed: 'test-model',
    latencyMs: 100,
    costInr: 1,
  };

  it(
    'marks the attempt PASS when qaScore >= 7',
    async () => {
      await handleStageResult(jobId, 'hsr_test_stage', 1, passResult);
      const attempt = await db.stageAttempt.findUniqueOrThrow({
        where: { jobId_stage_attemptNumber: { jobId, stage: 'hsr_test_stage', attemptNumber: 1 } },
      });
      expect(attempt.result).toBe('PASS');
    },
    15_000
  );

  it(
    'marks the attempt RETRY when qaScore < 7 and attempts remain',
    async () => {
      await handleStageResult(jobId, 'hsr_test_stage', 1, { ...passResult, qaScore: 5 });
      const attempt = await db.stageAttempt.findUniqueOrThrow({
        where: { jobId_stage_attemptNumber: { jobId, stage: 'hsr_test_stage', attemptNumber: 1 } },
      });
      expect(attempt.result).toBe('RETRY');
    },
    15_000
  );

  it(
    // MAX_CONTENT_RETRIES = 2 - the 2nd attempt is the last one, so a
    // failing score here escalates rather than retrying a 3rd time.
    'escalates the Job to NEEDS_ATTENTION when qaScore < 7 on the last allowed attempt',
    async () => {
      await db.stageAttempt.update({
        where: { jobId_stage_attemptNumber: { jobId, stage: 'hsr_test_stage', attemptNumber: 1 } },
        data: { attemptNumber: 2 },
      });
      await handleStageResult(jobId, 'hsr_test_stage', 2, { ...passResult, qaScore: 4 });
      const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe('NEEDS_ATTENTION');
    },
    15_000
  );

  // escalateTechnicalFailure() handles the case handleStageResult() never
  // sees: execute() itself throwing (e.g. a broken provider key) rather
  // than resolving a StageResult, after BullMQ's own technical retries
  // are exhausted - see pipeline-worker.ts's onFailed(). Added after a
  // real run against a broken OpenAI key left a job stuck forever with
  // no error visible anywhere - confirmed the fix live, this pins it.
  describe('escalateTechnicalFailure', () => {
    it(
      'marks the attempt ESCALATED and the job NEEDS_ATTENTION, with the reason in qaReasoning',
      async () => {
        await escalateTechnicalFailure(jobId, 'hsr_test_stage', 1, 'Request failed with status code 401');

        const attempt = await db.stageAttempt.findUniqueOrThrow({
          where: { jobId_stage_attemptNumber: { jobId, stage: 'hsr_test_stage', attemptNumber: 1 } },
        });
        expect(attempt.result).toBe('ESCALATED');
        expect(attempt.completedAt).not.toBeNull();
        expect(attempt.qaReasoning).toContain('401');

        const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
        expect(job.status).toBe('NEEDS_ATTENTION');
      },
      15_000
    );

    it(
      'persists the recovered assetUrl when generation succeeded and only scoring failed',
      async () => {
        await escalateTechnicalFailure(
          jobId,
          'hsr_test_stage',
          1,
          'Request failed with status code 401',
          'https://example.com/recovered.png'
        );

        const attempt = await db.stageAttempt.findUniqueOrThrow({
          where: { jobId_stage_attemptNumber: { jobId, stage: 'hsr_test_stage', attemptNumber: 1 } },
        });
        expect(attempt.assetUrl).toBe('https://example.com/recovered.png');
        expect(attempt.qaReasoning).toContain('generated successfully');
      },
      15_000
    );
  });
});
