import { db } from '../lib/db';
import { imageGenerationQueue, visionScoringQueue, type StageJobPayload } from './queue-definitions';
import { getStageDefinition } from '../orchestrator/stage-registry';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002'; // Prisma's error code for @@unique conflicts

/**
 * Dispatches one stage attempt. Idempotent: if this exact
 * (jobId, stage, attemptNumber) has already been dispatched, this is a
 * silent no-op rather than a duplicate provider call - per LLD §3.1.
 */
export async function dispatchStageJob(payload: StageJobPayload): Promise<void> {
  try {
    await db.stageAttempt.create({
      data: {
        jobId: payload.jobId,
        stage: payload.stage,
        attemptNumber: payload.attemptNumber,
        modelUsed: '', // filled in by the worker once the provider call completes
        latencyMs: 0,
        costInr: 0,
        result: 'RETRY', // placeholder until the worker resolves pass/retry/escalated
        startedAt: new Date(),
      },
    });
  } catch (err: any) {
    if (err?.code === UNIQUE_CONSTRAINT_VIOLATION) {
      // This exact attempt was already dispatched - do not enqueue a duplicate.
      return;
    }
    throw err;
  }

  const stageDef = getStageDefinition(payload.stage);
  const targetQueue = stageDef.queue === 'vision-scoring' ? visionScoringQueue : imageGenerationQueue;

  await targetQueue.add(payload.stage, payload, {
    attempts: 3, // BullMQ's own technical-failure retries, per LLD §4.2 - separate from content-quality retries
    backoff: { type: 'exponential', delay: 500 },
  });
}
