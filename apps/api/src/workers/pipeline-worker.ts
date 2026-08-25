import { Worker, type Job as BullJob } from 'bullmq';
import { db } from '../lib/db';
import { getStageDefinition } from '../orchestrator/stage-registry';
import { handleStageResult, escalateTechnicalFailure } from '../orchestrator/handle-stage-result';
import { stalledJobWorkerOptions } from '../queues/stalled-job-config';
import { logger } from '../lib/logger';
import { ScoringFailedError } from '../stages/generate-and-score';
import type { StageJobPayload } from '../queues/queue-definitions';

/**
 * The piece that was missing from the entire plan: nothing anywhere
 * connected "a stage job was dispatched to BullMQ" to "the stage
 * actually runs and reports a result." Both queues (image-generation,
 * vision-scoring) share this one processor - which provider function(s)
 * get called is entirely owned by each stage's execute() (Phase 6), not
 * decided here. This function only routes: look up the stage, run it,
 * hand the result to the Orchestrator.
 */
async function processStageJob(bullJob: BullJob<StageJobPayload>): Promise<void> {
  const { jobId, stage, attemptNumber, prompt, inputAssetUrl } = bullJob.data;
  const stageDef = getStageDefinition(stage);

  if (stageDef.isDeterministic) {
    // Deterministic stages run inline from the Orchestrator itself
    // (run-deterministic-stage.ts) and should never reach a queue.
    throw new Error(`Stage "${stage}" is deterministic and should never be queued`);
  }
  if (!stageDef.execute) {
    throw new Error(`Stage "${stage}" has no execute() implementation`);
  }

  const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });

  try {
    const result = await stageDef.execute(job, prompt, inputAssetUrl);
    await handleStageResult(jobId, stage, attemptNumber, result);
  } catch (err) {
    if (err instanceof ScoringFailedError) {
      // A ScoringFailedError means generation already succeeded (real
      // money spent, a real image sitting on Cloudinary) and only the
      // vision-scoring call failed - almost always a broken/misconfigured
      // provider key, not a transient blip. Left to BullMQ's normal
      // `attempts: 3` retry, this would silently re-run the whole
      // (paid) generate step 2 more times for a scoring call that will
      // fail identically every time. discard() stops that; escalating
      // right here (rather than waiting for the 'failed' event once
      // attempts exhaust) is what makes it happen after just one attempt
      // instead of three.
      bullJob.discard();
      await escalateTechnicalFailure(jobId, stage, attemptNumber, err.message, err.assetUrl);
    }
    throw err;
  }
}

async function onFailed(bullJob: BullJob<StageJobPayload> | undefined, err: Error): Promise<void> {
  logger.error(
    { err, job_id: bullJob?.data.jobId, stage: bullJob?.data.stage, attempt_number: bullJob?.data.attemptNumber },
    'worker_job_failed'
  );

  if (!bullJob || err instanceof ScoringFailedError) return; // already escalated in processStageJob
  const maxAttempts = bullJob.opts.attempts ?? 1;
  if (bullJob.attemptsMade < maxAttempts) return; // BullMQ will still retry this one

  await escalateTechnicalFailure(bullJob.data.jobId, bullJob.data.stage, bullJob.data.attemptNumber, err.message);
}

export const imageGenerationWorker = new Worker('image-generation', processStageJob, stalledJobWorkerOptions);
export const visionScoringWorker = new Worker('vision-scoring', processStageJob, stalledJobWorkerOptions);

imageGenerationWorker.on('failed', onFailed);
visionScoringWorker.on('failed', onFailed);
